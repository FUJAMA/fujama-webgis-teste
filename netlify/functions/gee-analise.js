// netlify/functions/gee-analise.js
// Análises espectrais via GEE. Padrão idêntico ao gee-tiles.js.

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

// Retorna as bandas RGB e NIR/SWIR corretas para cada sensor Landsat
// IMPORTANTE: select+rename ANTES de qualquer operação matemática
function landsatBands(year) {
  if (year >= 2022) return { col: 'LANDSAT/LC09/C02/T1_L2', rgb: ['SR_B4','SR_B3','SR_B2'], nir: 'SR_B5', swir2: 'SR_B7', green: 'SR_B3' };
  if (year >= 2013) return { col: 'LANDSAT/LC08/C02/T1_L2', rgb: ['SR_B4','SR_B3','SR_B2'], nir: 'SR_B5', swir2: 'SR_B7', green: 'SR_B3' };
  if (year >= 2003) return { col: 'LANDSAT/LE07/C02/T1_L2', rgb: ['SR_B3','SR_B2','SR_B1'], nir: 'SR_B4', swir2: 'SR_B7', green: 'SR_B2' };
  return              { col: 'LANDSAT/LT05/C02/T1_L2', rgb: ['SR_B3','SR_B2','SR_B1'], nir: 'SR_B4', swir2: 'SR_B7', green: 'SR_B2' };
}

exports.handler = function(event, context, callback) {
  if (event.httpMethod === 'OPTIONS') {
    return callback(null, { statusCode: 204, headers: CORS, body: '' });
  }

  var p    = event.queryStringParameters || {};
  var body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch(e) {} }

  var mode  = p.mode || body.mode || '';
  var CACHE = { 'Cache-Control': 'public, max-age=3600' };

  var pk;
  try { pk = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY); }
  catch(e) { return send(callback, 500, { error: 'GEE_SERVICE_ACCOUNT_KEY nao configurada' }); }

  // ── TIMELAPSE ────────────────────────────────────────────────────────────────
  if (mode === 'timelapse') {
    var yr    = parseInt(p.year  || body.year)  || 2015;
    var cld   = parseInt(p.cloud || body.cloud) || 20;
    var info  = landsatBands(yr);
    var start = String(yr) + '-01-01';
    var end   = String(yr) + '-12-31';

    return withEE(pk, function() {
      ee.ImageCollection(info.col)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUD_COVER', cld))
        .map(function(img) {
          // Seleciona, renomeia e escala — tudo numa cadeia sem reutilizar .select()
          return img.select(info.rgb, ['R','G','B'])
            .multiply(0.0000275).add(-0.2).clamp(0, 1);
        })
        .median()
        .multiply(255).uint8()
        .getMapId({ bands: ['R','G','B'], min: 0, max: 255, gamma: 1.4 },
          function(mapId, err) {
            if (err) return send(callback, 500, { error: 'timelapse: ' + err });
            send(callback, 200, { tileUrl: mapId.urlFormat, mode: 'timelapse', year: yr }, CACHE);
          });
    }, callback);
  }

  // ── NDVI ─────────────────────────────────────────────────────────────────────
  if (mode === 'ndvi') {
    var yr    = parseInt(p.year  || body.year)  || 2020;
    var cld   = parseInt(p.cloud || body.cloud) || 20;
    var info  = landsatBands(yr);
    var start = String(yr) + '-01-01';
    var end   = String(yr) + '-12-31';

    return withEE(pk, function() {
      ee.ImageCollection(info.col)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUD_COVER', cld))
        .map(function(img) {
          return img.select([info.nir, info.rgb[0]], ['NIR','R'])
            .multiply(0.0000275).add(-0.2).clamp(0, 1);
        })
        .median()
        .normalizedDifference(['NIR','R'])
        .getMapId({
          min: -0.3, max: 0.85,
          palette: ['d73027','f46d43','fdae61','fee08b','ffffbf','d9ef8b','a6d96a','66bd63','1a9850','006837']
        }, function(mapId, err) {
          if (err) return send(callback, 500, { error: 'ndvi: ' + err });
          send(callback, 200, { tileUrl: mapId.urlFormat, mode: 'ndvi', year: yr }, CACHE);
        });
    }, callback);
  }

  // ── EVI ──────────────────────────────────────────────────────────────────────
  if (mode === 'evi') {
    var yr    = parseInt(p.year  || body.year)  || 2020;
    var cld   = parseInt(p.cloud || body.cloud) || 20;
    var info  = landsatBands(yr);
    var start = String(yr) + '-01-01';
    var end   = String(yr) + '-12-31';

    return withEE(pk, function() {
      var med = ee.ImageCollection(info.col)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUD_COVER', cld))
        .map(function(img) {
          return img.select([info.nir, info.rgb[0], info.rgb[2]], ['NIR','R','B'])
            .multiply(0.0000275).add(-0.2).clamp(0, 1);
        })
        .median();
      med.expression(
        '2.5 * ((NIR - R) / (NIR + 6.0*R - 7.5*B + 1.0))',
        { NIR: med.select('NIR'), R: med.select('R'), B: med.select('B') }
      ).getMapId({
        min: -0.2, max: 0.8,
        palette: ['d73027','f46d43','fdae61','fee08b','ffffbf','d9ef8b','a6d96a','66bd63','1a9850','005a32']
      }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'evi: ' + err });
        send(callback, 200, { tileUrl: mapId.urlFormat, mode: 'evi', year: yr }, CACHE);
      });
    }, callback);
  }

  // ── NBR ──────────────────────────────────────────────────────────────────────
  if (mode === 'nbr') {
    var yr    = parseInt(p.year  || body.year)  || 2020;
    var cld   = parseInt(p.cloud || body.cloud) || 20;
    var info  = landsatBands(yr);
    var start = String(yr) + '-01-01';
    var end   = String(yr) + '-12-31';

    return withEE(pk, function() {
      ee.ImageCollection(info.col)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUD_COVER', cld))
        .map(function(img) {
          return img.select([info.nir, info.swir2], ['NIR','SWIR2'])
            .multiply(0.0000275).add(-0.2).clamp(0, 1);
        })
        .median()
        .normalizedDifference(['NIR','SWIR2'])
        .getMapId({
          min: -0.5, max: 0.9,
          palette: ['7a0403','d44d00','f5a623','ffffbe','c7e9b4','41b6c4','225ea8','0c2c84']
        }, function(mapId, err) {
          if (err) return send(callback, 500, { error: 'nbr: ' + err });
          send(callback, 200, { tileUrl: mapId.urlFormat, mode: 'nbr', year: yr }, CACHE);
        });
    }, callback);
  }

  // ── NDWI ─────────────────────────────────────────────────────────────────────
  if (mode === 'ndwi') {
    var yr    = parseInt(p.year  || body.year)  || 2020;
    var cld   = parseInt(p.cloud || body.cloud) || 20;
    var info  = landsatBands(yr);
    var start = String(yr) + '-01-01';
    var end   = String(yr) + '-12-31';

    return withEE(pk, function() {
      ee.ImageCollection(info.col)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUD_COVER', cld))
        .map(function(img) {
          return img.select([info.green, info.nir], ['G','NIR'])
            .multiply(0.0000275).add(-0.2).clamp(0, 1);
        })
        .median()
        .normalizedDifference(['G','NIR'])
        .getMapId({
          min: -0.5, max: 0.5,
          palette: ['d7191c','fdae61','ffffbf','abd9e9','2c7bb6']
        }, function(mapId, err) {
          if (err) return send(callback, 500, { error: 'ndwi: ' + err });
          send(callback, 200, { tileUrl: mapId.urlFormat, mode: 'ndwi', year: yr }, CACHE);
        });
    }, callback);
  }

  // ── DIFF NDVI ────────────────────────────────────────────────────────────────
  if (mode === 'diffndvi') {
    var yr1   = parseInt(p.year  || body.year)  || 2023;
    var yr2   = parseInt(p.year2 || body.year2) || 2015;
    var cld   = parseInt(p.cloud || body.cloud) || 20;
    var base  = Math.min(yr1, yr2);
    var comp  = Math.max(yr1, yr2);
    if (base === comp) return send(callback, 400, { error: 'year e year2 devem ser diferentes' });

    var infoBase = landsatBands(base);
    var infoComp = landsatBands(comp);

    return withEE(pk, function() {
      var ndviBase = ee.ImageCollection(infoBase.col)
        .filterDate(String(base) + '-01-01', String(base) + '-12-31')
        .filter(ee.Filter.lt('CLOUD_COVER', cld))
        .map(function(img) {
          return img.select([infoBase.nir, infoBase.rgb[0]], ['NIR','R'])
            .multiply(0.0000275).add(-0.2).clamp(0, 1);
        })
        .median()
        .normalizedDifference(['NIR','R']);

      var ndviComp = ee.ImageCollection(infoComp.col)
        .filterDate(String(comp) + '-01-01', String(comp) + '-12-31')
        .filter(ee.Filter.lt('CLOUD_COVER', cld))
        .map(function(img) {
          return img.select([infoComp.nir, infoComp.rgb[0]], ['NIR','R'])
            .multiply(0.0000275).add(-0.2).clamp(0, 1);
        })
        .median()
        .normalizedDifference(['NIR','R']);

      ndviComp.subtract(ndviBase)
        .getMapId({
          min: -0.5, max: 0.5,
          palette: ['7f0000','d73027','f46d43','fee08b','ffffbf','d9ef8b','66bd63','1a9850','004529']
        }, function(mapId, err) {
          if (err) return send(callback, 500, { error: 'diffndvi: ' + err });
          send(callback, 200, {
            tileUrl: mapId.urlFormat, mode: 'diffndvi', yearBase: base, yearComp: comp
          }, CACHE);
        });
    }, callback);
  }

  // ── DESMATAMENTO (Sentinel-2) ─────────────────────────────────────────────────
  if (mode === 'desmatamento') {
    var coords    = body.coords;
    var antesIni  = body.antes_ini  || '2017-01-01';
    var antesFim  = body.antes_fim  || '2019-12-31';
    var depoisIni = body.depois_ini || '2022-01-01';
    var depoisFim = body.depois_fim || '2024-12-31';
    var dsmCloud  = parseInt(body.cloud)       || 40;
    var threshold = parseFloat(body.threshold) || -0.3;

    if (!coords || coords.length < 3) {
      return send(callback, 400, { error: 'coords: minimo 3 pontos [[lng,lat],...]' });
    }

    return withEE(pk, function() {
      var geom = ee.Geometry.Polygon([coords]);

      function prepS2(img) {
        var mask = img.select('MSK_CLDPRB').lt(dsmCloud);
        var ndvi = img.select(['B8','B4']).multiply(0.0001)
          .normalizedDifference().rename('NDVI');
        return ndvi.updateMask(mask);
      }

      var antes  = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(geom).filterDate(antesIni, antesFim).map(prepS2).median();
      var depois = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(geom).filterDate(depoisIni, depoisFim).map(prepS2).median();

      var masked = depois.subtract(antes).lt(threshold).selfMask();

      masked.getMapId({ palette: ['ff2200'] }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'desmatamento getMapId: ' + err });

        masked.multiply(ee.Image.pixelArea()).divide(10000)
          .reduceRegion({
            reducer: ee.Reducer.sum(),
            geometry: geom, scale: 10, maxPixels: 1e9, bestEffort: true
          }).evaluate(function(stats, errStats) {
            var areaHa = 0;
            if (!errStats && stats) {
              var k = Object.keys(stats)[0];
              if (k && isFinite(stats[k])) areaHa = Math.round(stats[k] * 100) / 100;
            }
            geom.area(1).evaluate(function(totalM2) {
              var totalHa    = totalM2 ? Math.round(totalM2 / 100) / 100 : null;
              var percentual = (totalHa && totalHa > 0)
                ? Math.round(areaHa / totalHa * 10000) / 100 : null;
              send(callback, 200, {
                tileUrl: mapId.urlFormat,
                stats: {
                  areaHa: areaHa, totalHa: totalHa, percentual: percentual,
                  threshold: threshold,
                  antesIni: antesIni, antesFim: antesFim,
                  depoisIni: depoisIni, depoisFim: depoisFim
                }
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
