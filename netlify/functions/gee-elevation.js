// netlify/functions/gee-elevation.js
// Consulta elevação no MDT via Google Earth Engine.
//
// Modos:
//   GET ?mode=point&lat=...&lng=...
//       → retorna { elevation: <metros> } para um ponto
//
//   GET ?mode=profile&points=[[lat,lng],[lat,lng],...]
//       → retorna { elevations: [<m>, <m>, ...] } para uma lista de pontos
//
//   POST body = { mode: 'profile', points: [[lat,lng],...] }
//       → mesmo que acima, para listas longas
//
//   GET ?mode=area&minLat=...&maxLat=...&minLng=...&maxLng=...&cols=...&rows=...
//       → retorna { grid: [[e,...], ...], meta: {vmin,vmax,nodata} }
//         grade de elevações para cálculo volumétrico

var ee = require('@google/earthengine');

// ── Asset ID do MDT — ajuste para o caminho real no seu GEE ─────────────────
var MDT_ASSET = 'projects/webgis-492011/assets/MDT_GERAL';

// Valor nodata do raster
var NODATA = -9999;

// ── Inicialização GEE (singleton por cold-start da Lambda) ──────────────────
var _eeReady = false;
var _eeError = null;

function initEE(privateKey, onReady, onError) {
  if (_eeReady) { onReady(); return; }
  if (_eeError) { onError(_eeError); return; }

  ee.data.authenticateViaPrivateKey(privateKey, function() {
    ee.initialize(null, null, function() {
      _eeReady = true;
      onReady();
    }, function(err) {
      _eeError = err;
      onError(err);
    });
  }, function(err) {
    _eeError = err;
    onError(err);
  });
}

// ── CORS headers ─────────────────────────────────────────────────────────────
var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function resp(callback, status, body) {
  callback(null, { statusCode: status, headers: CORS, body: JSON.stringify(body) });
}

// ── Handler principal ─────────────────────────────────────────────────────────
exports.handler = function(event, context, callback) {

  if (event.httpMethod === 'OPTIONS') {
    return callback(null, { statusCode: 204, headers: CORS, body: '' });
  }

  // Lê parâmetros (GET ou POST JSON)
  var params = event.queryStringParameters || {};
  var body   = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch(e) {}
  }

  var mode = params.mode || body.mode || 'point';

  // Valida chave GEE
  var privateKey;
  try {
    privateKey = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY);
  } catch(e) {
    return resp(callback, 500, { error: 'GEE_SERVICE_ACCOUNT_KEY não configurada' });
  }

  initEE(privateKey, function() {
    var dem = ee.Image(MDT_ASSET).select(0);

    // ── mode=point ────────────────────────────────────────────────────────
    if (mode === 'point') {
      var lat = parseFloat(params.lat || body.lat);
      var lng = parseFloat(params.lng || body.lng);
      if (isNaN(lat) || isNaN(lng)) return resp(callback, 400, { error: 'lat e lng obrigatórios' });

      var pt = ee.Geometry.Point([lng, lat]);
      var result = dem.reduceRegion({
        reducer: ee.Reducer.first(),
        geometry: pt,
        scale: 1,
        maxPixels: 1
      });

      result.evaluate(function(val, err) {
        if (err) return resp(callback, 500, { error: err.toString() });
        var keys = Object.keys(val || {});
        var elev = keys.length > 0 ? val[keys[0]] : null;
        if (elev === null || elev === NODATA || !isFinite(elev)) {
          return resp(callback, 200, { elevation: null });
        }
        return resp(callback, 200, { elevation: Math.round(elev * 10) / 10 });
      });

    // ── mode=profile (lista de pontos) ────────────────────────────────────
    } else if (mode === 'profile') {
      var points;
      try {
        points = JSON.parse(params.points || '[]');
        if (!points.length && body.points) points = body.points;
      } catch(e) {
        return resp(callback, 400, { error: 'points deve ser JSON array [[lat,lng],...]' });
      }
      if (!points || points.length === 0) return resp(callback, 400, { error: 'points vazio' });

      // Limita a 500 pontos por request
      if (points.length > 500) points = points.slice(0, 500);

      // Cria FeatureCollection com os pontos
      var features = points.map(function(p, i) {
        return ee.Feature(ee.Geometry.Point([p[1], p[0]]), { idx: i });
      });
      var fc = ee.FeatureCollection(features);

      var sampled = dem.reduceRegions({
        collection: fc,
        reducer: ee.Reducer.first(),
        scale: 1
      });

      sampled.evaluate(function(result, err) {
        if (err) return resp(callback, 500, { error: err.toString() });

        // Reconstrói array ordenado por idx
        var elevations = new Array(points.length).fill(null);
        (result.features || []).forEach(function(f) {
          var idx = f.properties && f.properties.idx;
          var val = f.properties && f.properties.first;
          if (idx != null && val !== null && val !== NODATA && isFinite(val)) {
            elevations[idx] = Math.round(val * 10) / 10;
          }
        });

        return resp(callback, 200, { elevations: elevations });
      });

    // ── mode=area (grade para volumetria) ─────────────────────────────────
    } else if (mode === 'area') {
      var minLat = parseFloat(params.minLat || body.minLat);
      var maxLat = parseFloat(params.maxLat || body.maxLat);
      var minLng = parseFloat(params.minLng || body.minLng);
      var maxLng = parseFloat(params.maxLng || body.maxLng);
      var cols   = Math.min(200, parseInt(params.cols  || body.cols  || 50, 10));
      var rows   = Math.min(200, parseInt(params.rows  || body.rows  || 50, 10));

      if ([minLat, maxLat, minLng, maxLng].some(isNaN)) {
        return resp(callback, 400, { error: 'minLat, maxLat, minLng, maxLng obrigatórios' });
      }

      var bbox = ee.Geometry.Rectangle([minLng, minLat, maxLng, maxLat]);

      // Reamostra para grade cols×rows (pixelScale calculado pela bbox)
      var latRange = maxLat - minLat;
      var lngRange = maxLng - minLng;
      // Escala aproximada em metros por pixel
      var scaleM = Math.max(
        latRange * 111320 / rows,
        lngRange * 111320 * Math.cos((minLat + maxLat) / 2 * Math.PI / 180) / cols
      );

      var clipped = dem.clip(bbox);

      // Percentis para metadados
      var stats = dem.reduceRegion({
        reducer: ee.Reducer.percentile([2, 98]),
        geometry: bbox,
        scale: scaleM,
        maxPixels: 1e7,
        bestEffort: true
      });

      stats.evaluate(function(statsInfo, statsErr) {
        var vmin = 0, vmax = 1800;
        if (!statsErr && statsInfo) {
          Object.keys(statsInfo).forEach(function(k) {
            if (k.indexOf('p2')  !== -1 && isFinite(statsInfo[k])) vmin = statsInfo[k];
            if (k.indexOf('p98') !== -1 && isFinite(statsInfo[k])) vmax = statsInfo[k];
          });
        }

        // Coleta amostra de pixels via sampleRectangle
        clipped.sampleRectangle({
          region: bbox,
          defaultValue: NODATA
        }).evaluate(function(rectResult, rectErr) {
          if (rectErr) {
            // Fallback: usa reduceRegions com grade manual
            return buildGridFallback(dem, bbox, minLat, maxLat, minLng, maxLng,
              cols, rows, vmin, vmax, callback);
          }

          // sampleRectangle retorna um Feature com a propriedade = nome da banda
          var props = rectResult && rectResult.properties;
          if (!props) {
            return buildGridFallback(dem, bbox, minLat, maxLat, minLng, maxLng,
              cols, rows, vmin, vmax, callback);
          }

          var bandKey = Object.keys(props)[0];
          var rawGrid = props[bandKey]; // array 2D

          if (!rawGrid || !Array.isArray(rawGrid)) {
            return buildGridFallback(dem, bbox, minLat, maxLat, minLng, maxLng,
              cols, rows, vmin, vmax, callback);
          }

          // rawGrid é rows_nativo × cols_nativo — subsamplea para cols×rows
          var nRows = rawGrid.length;
          var nCols = rawGrid[0] ? rawGrid[0].length : 0;
          var grid = [];
          for (var r = 0; r < rows; r++) {
            var row = [];
            var ri = Math.min(nRows - 1, Math.floor(r * nRows / rows));
            for (var c = 0; c < cols; c++) {
              var ci = Math.min(nCols - 1, Math.floor(c * nCols / cols));
              var v = rawGrid[ri][ci];
              row.push((v === NODATA || !isFinite(v)) ? null : Math.round(v * 10) / 10);
            }
            grid.push(row);
          }

          return resp(callback, 200, {
            grid: grid,
            meta: { vmin: vmin, vmax: vmax, nodata: null, rows: rows, cols: cols,
                    minLat: minLat, maxLat: maxLat, minLng: minLng, maxLng: maxLng }
          });
        });
      });

    } else {
      return resp(callback, 400, { error: 'mode inválido. Use: point | profile | area' });
    }

  }, function(err) {
    resp(callback, 500, { error: 'GEE init error: ' + err });
  });
};

// ── Fallback para grade via FeatureCollection (mais lento mas robusto) ───────
function buildGridFallback(dem, bbox, minLat, maxLat, minLng, maxLng,
    cols, rows, vmin, vmax, callback) {

  var features = [];
  var idx = 0;
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      var lat = minLat + (r + 0.5) * (maxLat - minLat) / rows;
      var lng = minLng + (c + 0.5) * (maxLng - minLng) / cols;
      features.push(ee.Feature(ee.Geometry.Point([lng, lat]), { idx: idx, r: r, c: c }));
      idx++;
    }
  }

  var fc = ee.FeatureCollection(features);
  var sampled = dem.reduceRegions({ collection: fc, reducer: ee.Reducer.first(), scale: 5 });

  sampled.evaluate(function(result, err) {
    if (err) {
      return callback(null, {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: err.toString() })
      });
    }

    var grid = [];
    for (var r2 = 0; r2 < rows; r2++) {
      grid.push(new Array(cols).fill(null));
    }

    (result.features || []).forEach(function(f) {
      var r = f.properties.r, c = f.properties.c;
      var v = f.properties.first;
      if (v !== null && v !== -9999 && isFinite(v)) grid[r][c] = Math.round(v * 10) / 10;
    });

    callback(null, {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json',
                 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        grid: grid,
        meta: { vmin: vmin, vmax: vmax, nodata: null, rows: rows, cols: cols,
                minLat: minLat, maxLat: maxLat, minLng: minLng, maxLng: maxLng }
      })
    });
  });
}
