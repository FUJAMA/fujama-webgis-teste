// netlify/functions/gee-analise.js
// Padrão singleton withEE idêntico ao gee-elevation.js.
//
// POST { mode:'desmatamento', coords, antes_ini, antes_fim, depois_ini, depois_fim, cloud, threshold }
// GET  ?mode=ndvi|evi|nbr|ndwi|timelapse &year=YYYY &cloud=N

var ee = require('@google/earthengine');

var CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function send(cb, status, body, extra) {
  cb(null, {
    statusCode: status,
    headers:    Object.assign({}, CORS, extra || {}),
    body:       JSON.stringify(body)
  });
}

// ── Singleton idêntico ao gee-elevation.js ────────────────────────────────────
var _ready   = false;
var _initErr = null;

function withEE(pk, fn, cb) {
  if (_ready)   { fn(); return; }
  if (_initErr) { return send(cb, 500, { error: 'GEE init falhou: ' + _initErr }); }
  ee.data.authenticateViaPrivateKey(pk, function() {
    ee.initialize(null, null, function() {
      _ready = true;
      fn();
    }, function(e) { _initErr = e; send(cb, 500, { error: 'GEE init: ' + e }); });
  }, function(e) { _initErr = e; send(cb, 500, { error: 'GEE auth: ' + e }); });
}

// ── Coleção Landsat L2 SR por ano ─────────────────────────────────────────────
function getLandsat(year, cloudMax) {
  var s = ee.Date.fromYMD(year, 1, 1);
  var e = ee.Date.fromYMD(year, 12, 31);
  var c = cloudMax || 20;

  function scale(img) {
    return img.select(['SR_B.*']).multiply(0.0000275).add(-0.2)
      .copyProperties(img, ['system:time_start']);
  }

  if (year >= 2022) {
    return ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
      .filterDate(s, e).filter(ee.Filter.lt('CLOUD_COVER', c))
      .map(function(img) {
        return scale(img).select(
          ['SR_B4','SR_B3','SR_B2','SR_B5','SR_B6','SR_B7'],
          ['R',    'G',    'B',    'NIR',  'SWIR1','SWIR2']);
      });
  }
  if (year >= 2013) {
    return ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
      .filterDate(s, e).filter(ee.Filter.lt('CLOUD_COVER', c))
      .map(function(img) {
        return scale(img).select(
          ['SR_B4','SR_B3','SR_B2','SR_B5','SR_B6','SR_B7'],
          ['R',    'G',    'B',    'NIR',  'SWIR1','SWIR2']);
      });
  }
  if (year >= 2003) {
    return ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
      .filterDate(s, e).filter(ee.Filter.lt('CLOUD_COVER', c))
      .map(function(img) {
        return scale(img).select(
          ['SR_B3','SR_B2','SR_B1','SR_B4','SR_B5','SR_B7'],
          ['R',    'G',    'B',    'NIR',  'SWIR1','SWIR2']);
      });
  }
  return ee.ImageCollection('LANDSAT/LT05/C02/T1_L2')
    .filterDate(s, e).filter(ee.Filter.lt('CLOUD_COVER', c))
    .map(function(img) {
      return scale(img).select(
        ['SR_B3','SR_B2','SR_B1','SR_B4','SR_B5','SR_B7'],
        ['R',    'G',    'B',    'NIR',  'SWIR1','SWIR2']);
    });
}

// ── Sentinel-2 com máscara de nuvens ─────────────────────────────────────────
function getS2(geom, dateStart, dateEnd, cloudMax) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(geom)
    .filterDate(dateStart, dateEnd)
    .map(function(img) {
      var mask = img.select('MSK_CLDPRB').lt(cloudMax);
      var ndvi = img.normalizedDifference(['B8', 'B4']).rename('NDVI');
      return img.select(['B2','B3','B4','B8']).addBands(ndvi).updateMask(mask);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
exports.handler = function(event, context, callback) {
  if (event.httpMethod === 'OPTIONS') {
    return callback(null, { statusCode: 204, headers: CORS, body: '' });
  }

  var p    = event.queryStringParameters || {};
  var body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch(e) {} }

  var mode = p.mode || body.mode || 'timelapse';
  var CACHE = { 'Cache-Control': 'public, max-age=3600' };

  var pk;
  try { pk = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY); }
  catch(e) { return send(callback, 500, { error: 'GEE_SERVICE_ACCOUNT_KEY nao configurada' }); }

  // ── TIMELAPSE ────────────────────────────────────────────────────────────────
  if (mode === 'timelapse') {
    var tlYear  = parseInt(p.year  || body.year)  || 2015;
    var tlCloud = parseInt(p.cloud || body.cloud) || 20;
    if (tlYear < 1985 || tlYear > 2025) {
      return send(callback, 400, { error: 'year fora do intervalo 1985-2025' });
    }
    return withEE(pk, function() {
      var col = getLandsat(tlYear, tlCloud);
      var rgb = col.median().select(['R','G','B'])
        .multiply(255).clamp(0, 255).uint8();
      rgb.getMapId({ bands: ['R','G','B'], min: 0, max: 255, gamma: 1.4 },
        function(mapId, err) {
          if (err) return send(callback, 500, { error: 'timelapse getMapId: ' + err });
          send(callback, 200,
            { tileUrl: mapId.urlFormat, mode: 'timelapse', year: tlYear }, CACHE);
        });
    }, callback);
  }

  // ── NDVI ─────────────────────────────────────────────────────────────────────
  if (mode === 'ndvi') {
    var ndviYear  = parseInt(p.year  || body.year)  || 2020;
    var ndviCloud = parseInt(p.cloud || body.cloud) || 20;
    return withEE(pk, function() {
      var ndvi = getLandsat(ndviYear, ndviCloud).median()
        .normalizedDifference(['NIR','R']).rename('NDVI');
      ndvi.getMapId({
        min: -0.3, max: 0.85,
        palette: ['d73027','f46d43','fdae61','fee08b','ffffbf',
                  'd9ef8b','a6d96a','66bd63','1a9850','006837']
      }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'ndvi getMapId: ' + err });
        send(callback, 200,
          { tileUrl: mapId.urlFormat, mode: 'ndvi', year: ndviYear }, CACHE);
      });
    }, callback);
  }

  // ── EVI ──────────────────────────────────────────────────────────────────────
  if (mode === 'evi') {
    var eviYear  = parseInt(p.year  || body.year)  || 2020;
    var eviCloud = parseInt(p.cloud || body.cloud) || 20;
    return withEE(pk, function() {
      var med = getLandsat(eviYear, eviCloud).median();
      var evi = med.expression(
        '2.5 * ((NIR - R) / (NIR + 6*R - 7.5*B + 1))',
        { NIR: med.select('NIR'), R: med.select('R'), B: med.select('B') }
      ).rename('EVI');
      evi.getMapId({
        min: -0.2, max: 0.8,
        palette: ['d73027','f46d43','fdae61','fee08b','ffffbf',
                  'd9ef8b','a6d96a','66bd63','1a9850','005a32']
      }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'evi getMapId: ' + err });
        send(callback, 200,
          { tileUrl: mapId.urlFormat, mode: 'evi', year: eviYear }, CACHE);
      });
    }, callback);
  }

  // ── NBR ──────────────────────────────────────────────────────────────────────
  if (mode === 'nbr') {
    var nbrYear  = parseInt(p.year  || body.year)  || 2020;
    var nbrCloud = parseInt(p.cloud || body.cloud) || 20;
    return withEE(pk, function() {
      var nbr = getLandsat(nbrYear, nbrCloud).median()
        .normalizedDifference(['NIR','SWIR2']).rename('NBR');
      nbr.getMapId({
        min: -0.5, max: 0.9,
        palette: ['7a0403','d44d00','f5a623','ffffbe','c7e9b4','41b6c4','225ea8','0c2c84']
      }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'nbr getMapId: ' + err });
        send(callback, 200,
          { tileUrl: mapId.urlFormat, mode: 'nbr', year: nbrYear }, CACHE);
      });
    }, callback);
  }

  // ── NDWI ─────────────────────────────────────────────────────────────────────
  if (mode === 'ndwi') {
    var ndwiYear  = parseInt(p.year  || body.year)  || 2020;
    var ndwiCloud = parseInt(p.cloud || body.cloud) || 20;
    return withEE(pk, function() {
      var ndwi = getLandsat(ndwiYear, ndwiCloud).median()
        .normalizedDifference(['G','NIR']).rename('NDWI');
      ndwi.getMapId({
        min: -0.5, max: 0.5,
        palette: ['d7191c','fdae61','ffffbf','abd9e9','2c7bb6']
      }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'ndwi getMapId: ' + err });
        send(callback, 200,
          { tileUrl: mapId.urlFormat, mode: 'ndwi', year: ndwiYear }, CACHE);
      });
    }, callback);
  }

  // ── DIFF NDVI ────────────────────────────────────────────────────────────────
  if (mode === 'diffndvi') {
    var diffYear  = parseInt(p.year  || body.year)  || 2023;
    var diffYear2 = parseInt(p.year2 || body.year2) || 2015;
    var diffCloud = parseInt(p.cloud || body.cloud) || 20;
    var base = Math.min(diffYear, diffYear2);
    var comp = Math.max(diffYear, diffYear2);
    if (base === comp) return send(callback, 400, { error: 'year e year2 devem ser diferentes' });
    return withEE(pk, function() {
      var ndviBase = getLandsat(base, diffCloud).median().normalizedDifference(['NIR','R']);
      var ndviComp = getLandsat(comp, diffCloud).median().normalizedDifference(['NIR','R']);
      var diff = ndviComp.subtract(ndviBase).rename('dNDVI');
      diff.getMapId({
        min: -0.5, max: 0.5,
        palette: ['7f0000','d73027','f46d43','fee08b','ffffbf',
                  'd9ef8b','66bd63','1a9850','004529']
      }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'diffndvi getMapId: ' + err });
        send(callback, 200,
          { tileUrl: mapId.urlFormat, mode: 'diffndvi', yearBase: base, yearComp: comp }, CACHE);
      });
    }, callback);
  }

  // ── DESMATAMENTO (POST) ───────────────────────────────────────────────────────
  if (mode === 'desmatamento') {
    var coords    = body.coords;
    var antesIni  = body.antes_ini  || '2017-01-01';
    var antesFim  = body.antes_fim  || '2019-12-31';
    var depoisIni = body.depois_ini || '2022-01-01';
    var depoisFim = body.depois_fim || '2024-12-31';
    var dsmCloud  = parseInt(body.cloud)      || 40;
    var threshold = parseFloat(body.threshold) || -0.3;

    if (!coords || coords.length < 3) {
      return send(callback, 400, { error: 'coords: minimo 3 pontos [[lng,lat],...]' });
    }

    return withEE(pk, function() {
      var geom   = ee.Geometry.Polygon([coords]);
      var antes  = getS2(geom, antesIni,  antesFim,  dsmCloud).median();
      var depois = getS2(geom, depoisIni, depoisFim, dsmCloud).median();
      var diff   = depois.select('NDVI').subtract(antes.select('NDVI'));
      var masked = diff.lt(threshold).selfMask();

      masked.getMapId({ palette: ['ff2200'] }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'desmatamento getMapId: ' + err });

        var areaImg = masked.multiply(ee.Image.pixelArea()).divide(10000);
        areaImg.reduceRegion({
          reducer: ee.Reducer.sum(),
          geometry: geom, scale: 10, maxPixels: 1e9, bestEffort: true
        }).evaluate(function(stats, errStats) {
          var areaHa = 0;
          if (!errStats && stats) {
            var v = stats[Object.keys(stats)[0]];
            if (v && isFinite(v)) areaHa = Math.round(v * 100) / 100;
          }
          geom.area(1).evaluate(function(totalM2) {
            var totalHa    = totalM2 ? Math.round(totalM2 / 100) / 100 : null;
            var percentual = (totalHa && totalHa > 0)
              ? Math.round(areaHa / totalHa * 10000) / 100 : null;
            send(callback, 200, {
              tileUrl: mapId.urlFormat,
              stats: { areaHa, totalHa, percentual, threshold,
                       antesIni, antesFim, depoisIni, depoisFim }
            }, CACHE);
          });
        });
      });
    }, callback);
  }

  return send(callback, 400, {
    error: 'mode invalido. Use: timelapse | ndvi | evi | nbr | ndwi | diffndvi | desmatamento'
  });
};
