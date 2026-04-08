// netlify/functions/gee-elevation.js
// Consulta elevacao no MDT via Google Earth Engine (server-side, sem CORS).
//
// Endpoints:
//   GET ?mode=point&lat=...&lng=...
//       Retorna { elevation: <metros> }
//
//   GET ?mode=profile&points=[[lat,lng],[lat,lng],...]
//   POST { mode:'profile', points:[[lat,lng],...] }
//       Retorna { elevations: [<m>, <m>, ...] }
//
//   GET ?mode=area&minLat=...&maxLat=...&minLng=...&maxLng=...&cols=N&rows=N
//       Retorna { grid:[[e,...],...], meta:{vmin,vmax,rows,cols,minLat,maxLat,minLng,maxLng} }
//       Usado pelo card de Volumetria.
//
//   GET ?mode=meta
//       Retorna { vmin, vmax } — estatisticas do DEM para uso nos cards.

var ee = require('@google/earthengine');

var MDT_ID = 'projects/webgis-492011/assets/MDT_GERAL';
var NODATA  = -9999;

var CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function send(cb, status, body) {
  cb(null, { statusCode: status, headers: CORS, body: JSON.stringify(body) });
}

// Singleton de inicializacao (reutiliza entre requests quentes)
var _ready = false;
var _initErr = null;

function withEE(privateKey, fn, cb) {
  if (_ready)    { fn(); return; }
  if (_initErr)  { send(cb, 500, { error: 'GEE init anterior falhou: ' + _initErr }); return; }

  ee.data.authenticateViaPrivateKey(privateKey, function() {
    ee.initialize(null, null, function() {
      _ready = true;
      fn();
    }, function(err) { _initErr = err; send(cb, 500, { error: 'GEE init: ' + err }); });
  }, function(err) { _initErr = err; send(cb, 500, { error: 'GEE auth: ' + err }); });
}

exports.handler = function(event, context, callback) {
  if (event.httpMethod === 'OPTIONS') {
    return callback(null, { statusCode: 204, headers: CORS, body: '' });
  }

  var params = event.queryStringParameters || {};
  var body   = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch(e) {} }

  var mode = params.mode || body.mode || 'point';

  var privateKey;
  try {
    privateKey = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY);
  } catch(e) {
    return send(callback, 500, { error: 'GEE_SERVICE_ACCOUNT_KEY nao configurada' });
  }

  withEE(privateKey, function() {
    var dem = ee.Image(MDT_ID).select(0);

    // ── mode=meta: min/max do DEM ─────────────────────────────────────────
    if (mode === 'meta') {
      dem.reduceRegion({
        reducer: ee.Reducer.percentile([2, 98]),
        scale: 30, maxPixels: 1e8, bestEffort: true
      }).evaluate(function(stats, err) {
        if (err) return send(callback, 500, { error: err.toString() });
        var vmin = 0, vmax = 1800;
        Object.keys(stats || {}).forEach(function(k) {
          var v = stats[k];
          if (!isFinite(v)) return;
          if (k.slice(-3) === '_p2'  || k === 'p2')  vmin = v;
          if (k.slice(-4) === '_p98' || k === 'p98') vmax = v;
        });
        send(callback, 200, { vmin: vmin, vmax: vmax });
      });

    // ── mode=point ────────────────────────────────────────────────────────
    } else if (mode === 'point') {
      var lat = parseFloat(params.lat || body.lat);
      var lng = parseFloat(params.lng || body.lng);
      if (isNaN(lat) || isNaN(lng)) return send(callback, 400, { error: 'lat e lng obrigatorios' });

      dem.reduceRegion({
        reducer: ee.Reducer.first(),
        geometry: ee.Geometry.Point([lng, lat]),
        scale: 1, maxPixels: 1
      }).evaluate(function(val, err) {
        if (err) return send(callback, 500, { error: err.toString() });
        var keys = Object.keys(val || {});
        var elev = keys.length ? val[keys[0]] : null;
        if (elev === null || elev === NODATA || !isFinite(elev)) elev = null;
        else elev = Math.round(elev * 10) / 10;
        send(callback, 200, { elevation: elev });
      });

    // ── mode=profile ──────────────────────────────────────────────────────
    } else if (mode === 'profile') {
      var points;
      try {
        points = params.points ? JSON.parse(params.points) : body.points;
      } catch(e) {
        return send(callback, 400, { error: 'points invalido' });
      }
      if (!points || !points.length) return send(callback, 400, { error: 'points vazio' });
      if (points.length > 500) points = points.slice(0, 500);

      var features = points.map(function(p, i) {
        return ee.Feature(ee.Geometry.Point([p[1], p[0]]), { idx: i });
      });

      dem.reduceRegions({
        collection: ee.FeatureCollection(features),
        reducer: ee.Reducer.first(),
        scale: 1
      }).evaluate(function(result, err) {
        if (err) return send(callback, 500, { error: err.toString() });
        var elevs = new Array(points.length).fill(null);
        (result.features || []).forEach(function(f) {
          var idx = f.properties && f.properties.idx;
          var v   = f.properties && f.properties.first;
          if (idx != null && v !== null && v !== NODATA && isFinite(v))
            elevs[idx] = Math.round(v * 10) / 10;
        });
        send(callback, 200, { elevations: elevs });
      });

    // ── mode=area: grade para volumetria ─────────────────────────────────
    } else if (mode === 'area') {
      var minLat = parseFloat(params.minLat || body.minLat);
      var maxLat = parseFloat(params.maxLat || body.maxLat);
      var minLng = parseFloat(params.minLng || body.minLng);
      var maxLng = parseFloat(params.maxLng || body.maxLng);
      var cols   = Math.min(150, Math.max(10, parseInt(params.cols || body.cols || 60, 10)));
      var rows   = Math.min(150, Math.max(10, parseInt(params.rows || body.rows || 60, 10)));

      if ([minLat, maxLat, minLng, maxLng].some(isNaN))
        return send(callback, 400, { error: 'minLat maxLat minLng maxLng obrigatorios' });

      var bbox = ee.Geometry.Rectangle([minLng, minLat, maxLng, maxLat]);

      // Estatisticas para metadados
      dem.reduceRegion({
        reducer: ee.Reducer.percentile([2, 98]),
        geometry: bbox, scale: 30, maxPixels: 1e7, bestEffort: true
      }).evaluate(function(stats, statsErr) {
        var vmin = 0, vmax = 1800;
        Object.keys(stats || {}).forEach(function(k) {
          var v = (stats || {})[k];
          if (!isFinite(v)) return;
          if (k.slice(-3) === '_p2'  || k === 'p2')  vmin = v;
          if (k.slice(-4) === '_p98' || k === 'p98') vmax = v;
        });

        // Monta grade de pontos e amostra
        var features = [];
        for (var r = 0; r < rows; r++) {
          for (var c = 0; c < cols; c++) {
            var lat2 = minLat + (r + 0.5) * (maxLat - minLat) / rows;
            var lng2 = minLng + (c + 0.5) * (maxLng - minLng) / cols;
            features.push(ee.Feature(
              ee.Geometry.Point([lng2, lat2]),
              { r: r, c: c }
            ));
          }
        }

        dem.reduceRegions({
          collection: ee.FeatureCollection(features),
          reducer: ee.Reducer.first(),
          scale: 5
        }).evaluate(function(result, err) {
          if (err) return send(callback, 500, { error: err.toString() });

          // Monta grade 2D rows x cols
          var grid = [];
          for (var r2 = 0; r2 < rows; r2++) {
            grid.push(new Array(cols).fill(null));
          }
          (result.features || []).forEach(function(f) {
            var r3 = f.properties.r, c2 = f.properties.c;
            var v  = f.properties.first;
            if (v !== null && v !== NODATA && isFinite(v))
              grid[r3][c2] = Math.round(v * 10) / 10;
          });

          send(callback, 200, {
            grid: grid,
            meta: {
              vmin: vmin, vmax: vmax,
              rows: rows, cols: cols,
              minLat: minLat, maxLat: maxLat,
              minLng: minLng, maxLng: maxLng
            }
          });
        });
      });

    } else {
      send(callback, 400, { error: 'mode invalido: point | profile | area | meta' });
    }

  }, callback);
};
