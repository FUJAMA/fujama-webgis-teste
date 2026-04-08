// netlify/functions/gee-analise.js
// Análises espectrais Sentinel-2 via Google Earth Engine.
// Padrão singleton withEE idêntico ao gee-elevation.js.
//
// POST { coords, antes_ini, antes_fim, depois_ini, depois_fim, cloud, threshold }
//   → { tileUrl, stats: { areaHa, percentual } }
//
// GET ?mode=ndvi|evi|nbr|ndwi|timelapse &year=YYYY &cloud=N
//   → { tileUrl }

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
    headers: Object.assign({}, CORS, extra || {}),
    body: JSON.stringify(body)
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
      _ready = true; fn();
    }, function(e) { _initErr = e; send(cb, 500, { error: 'GEE init: ' + e }); });
  }, function(e) { _initErr = e; send(cb, 500, { error: 'GEE auth: ' + e }); });
}

// ── Máscara de nuvens Sentinel-2 ─────────────────────────────────────────────
function maskS2(cloudMax) {
  return function(image) {
    var prob = image.select('MSK_CLDPRB');
    return image.updateMask(prob.lt(cloudMax));
  };
}

// ── Prepara imagem Sentinel-2 com NDVI ───────────────────────────────────────
function prepS2(image) {
  var ndvi = image.normalizedDifference(['B8', 'B4']).rename('NDVI');
  return image.select(['B2','B3','B4','B8']).addBands(ndvi);
}

// ── Coleção Sentinel-2 filtrada ───────────────────────────────────────────────
function getS2(geom, dateStart, dateEnd, cloudMax) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(geom)
    .filterDate(dateStart, dateEnd)
    .map(maskS2(cloudMax))
    .map(prepS2);
}

// ── Coleção Landsat (para modo timelapse/índices sem geometria) ───────────────
function getLandsat(year, cloudMax) {
  var s = year + '-01-01', e = year + '-12-31', c = cloudMax || 20;
  var scale = function(img) {
    return img.select(['SR_B.*']).multiply(0.0000275).add(-0.2)
      .copyProperties(img, ['system:time_start']);
  };
  if (year >= 2022) {
    return ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
      .filterDate(s,e).filter(ee.Filter.lt('CLOUD_COVER',c))
      .map(function(img){ return scale(img).select(['SR_B4','SR_B3','SR_B2','SR_B5','SR_B6','SR_B7'],['R','G','B','NIR','SWIR1','SWIR2']); });
  }
  if (year >= 2013) {
    return ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
      .filterDate(s,e).filter(ee.Filter.lt('CLOUD_COVER',c))
      .map(function(img){ return scale(img).select(['SR_B4','SR_B3','SR_B2','SR_B5','SR_B6','SR_B7'],['R','G','B','NIR','SWIR1','SWIR2']); });
  }
  if (year >= 2003) {
    return ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
      .filterDate(s,e).filter(ee.Filter.lt('CLOUD_COVER',c))
      .map(function(img){ return scale(img).select(['SR_B3','SR_B2','SR_B1','SR_B4','SR_B5','SR_B7'],['R','G','B','NIR','SWIR1','SWIR2']); });
  }
  return ee.ImageCollection('LANDSAT/LT05/C02/T1_L2')
    .filterDate(s,e).filter(ee.Filter.lt('CLOUD_COVER',c))
    .map(function(img){ return scale(img).select(['SR_B3','SR_B2','SR_B1','SR_B4','SR_B5','SR_B7'],['R','G','B','NIR','SWIR1','SWIR2']); });
}

// ─────────────────────────────────────────────────────────────────────────────
exports.handler = function(event, context, callback) {
  if (event.httpMethod === 'OPTIONS') {
    return callback(null, { statusCode: 204, headers: CORS, body: '' });
  }

  // Lê params (GET ou POST JSON)
  var p = event.queryStringParameters || {};
  var body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch(e) {} }

  var mode = p.mode || body.mode || 'desmatamento';

  var pk;
  try { pk = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY); }
  catch(e) { return send(callback, 500, { error: 'GEE_SERVICE_ACCOUNT_KEY nao configurada' }); }

  withEE(pk, function() {

    var CACHE = { 'Cache-Control': 'public, max-age=3600' };

    // ══════════════════════════════════════════════════════════════════════
    // MODO: desmatamento  (POST com geometria + períodos)
    // ══════════════════════════════════════════════════════════════════════
    if (mode === 'desmatamento') {
      var coords     = body.coords;          // [[lng,lat], ...]
      var antesIni   = body.antes_ini   || '2017-01-01';
      var antesFim   = body.antes_fim   || '2019-12-31';
      var depoisIni  = body.depois_ini  || '2022-01-01';
      var depoisFim  = body.depois_fim  || '2024-12-31';
      var cloudMax   = parseInt(body.cloud)     || 40;
      var threshold  = parseFloat(body.threshold) || -0.3;

      if (!coords || coords.length < 3) {
        return send(callback, 400, { error: 'coords: mínimo 3 pontos [[lng,lat],...]' });
      }

      var geom = ee.Geometry.Polygon([coords]);

      var antes  = getS2(geom, antesIni,  antesFim,  cloudMax).median();
      var depois = getS2(geom, depoisIni, depoisFim, cloudMax).median();

      var diff        = depois.select('NDVI').subtract(antes.select('NDVI'));
      var desmatamento = diff.lt(threshold);
      var masked       = desmatamento.updateMask(desmatamento);

      // Tile visual
      masked.getMapId({ palette: ['ff2200'] }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'desmatamento getMapId: ' + err });

        // Calcula área desmatada em ha
        var areaImg = masked.multiply(ee.Image.pixelArea()).divide(10000);
        areaImg.reduceRegion({
          reducer:   ee.Reducer.sum(),
          geometry:  geom,
          scale:     10,
          maxPixels: 1e9,
          bestEffort: true
        }).evaluate(function(stats, errStats) {
          var areaHa = 0;
          if (!errStats && stats) {
            var v = stats[Object.keys(stats)[0]];
            if (v && isFinite(v)) areaHa = Math.round(v * 100) / 100;
          }

          // Área total da geometria
          geom.area(1).evaluate(function(totalM2) {
            var totalHa   = totalM2 ? Math.round(totalM2 / 100) / 100 : null;
            var percentual = (totalHa && totalHa > 0)
              ? Math.round(areaHa / totalHa * 10000) / 100
              : null;

            send(callback, 200, {
              tileUrl:    mapId.urlFormat,
              stats: {
                areaHa:    areaHa,
                totalHa:   totalHa,
                percentual: percentual,
                threshold:  threshold,
                antesIni:   antesIni,
                antesFim:   antesFim,
                depoisIni:  depoisIni,
                depoisFim:  depoisFim
              }
            }, CACHE);
          });
        });
      });

    // ══════════════════════════════════════════════════════════════════════
    // MODO: ndvi | evi | nbr | ndwi  (Landsat, sem geometria específica)
    // ══════════════════════════════════════════════════════════════════════
    } else if (['ndvi','evi','nbr','ndwi'].indexOf(mode) !== -1) {
      var year  = parseInt(p.year  || body.year)  || (new Date().getFullYear() - 1);
      var cloud = parseInt(p.cloud || body.cloud) || 20;
      var med   = getLandsat(year, cloud).median();

      var visParams, img;
      if (mode === 'ndvi') {
        img = med.normalizedDifference(['NIR','R']).rename('NDVI');
        visParams = { min:-0.3, max:0.85,
          palette:['d73027','f46d43','fdae61','fee08b','ffffbf','d9ef8b','a6d96a','66bd63','1a9850','006837'] };
      } else if (mode === 'evi') {
        img = med.expression('2.5*((NIR-R)/(NIR+6*R-7.5*B+1))',
          { NIR:med.select('NIR'), R:med.select('R'), B:med.select('B') }).rename('EVI');
        visParams = { min:-0.2, max:0.8,
          palette:['d73027','f46d43','fdae61','fee08b','ffffbf','d9ef8b','a6d96a','66bd63','1a9850','005a32'] };
      } else if (mode === 'nbr') {
        img = med.normalizedDifference(['NIR','SWIR2']).rename('NBR');
        visParams = { min:-0.5, max:0.9,
          palette:['7a0403','d44d00','f5a623','ffffbe','c7e9b4','41b6c4','225ea8','0c2c84'] };
      } else {
        img = med.normalizedDifference(['G','NIR']).rename('NDWI');
        visParams = { min:-0.5, max:0.5,
          palette:['d7191c','fdae61','ffffbf','abd9e9','2c7bb6'] };
      }

      img.getMapId(visParams, function(mapId, err) {
        if (err) return send(callback, 500, { error: mode + ' getMapId: ' + err });
        send(callback, 200, { tileUrl: mapId.urlFormat, mode:mode, year:year }, CACHE);
      });

    // ══════════════════════════════════════════════════════════════════════
    // MODO: timelapse  (Landsat true-color)
    // ══════════════════════════════════════════════════════════════════════
    } else if (mode === 'timelapse') {
      var tlYear  = parseInt(p.year  || body.year)  || 2015;
      var tlCloud = parseInt(p.cloud || body.cloud) || 20;
      var rgb = getLandsat(tlYear, tlCloud).median()
        .select(['R','G','B']).multiply(255).clamp(0,255).uint8();
      rgb.getMapId({ bands:['R','G','B'], min:0, max:255, gamma:1.4 }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'timelapse getMapId: ' + err });
        send(callback, 200, { tileUrl: mapId.urlFormat, mode:'timelapse', year:tlYear }, CACHE);
      });

    } else {
      send(callback, 400, { error: 'mode inválido. Use: desmatamento | ndvi | evi | nbr | ndwi | timelapse' });
    }

  }, callback);
};
