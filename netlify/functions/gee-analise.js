// netlify/functions/gee-analise.js
// Análises espectrais próprias via Google Earth Engine:
//   mode=ndvi       — NDVI anual (vegetação)
//   mode=evi        — EVI anual (Enhanced Vegetation Index)
//   mode=nbr        — NBR (Normalized Burn Ratio — risco/cicatrizes de incêndio)
//   mode=ndwi       — NDWI (corpos d'água / umidade)
//   mode=diffndvi   — Diferença NDVI entre dois anos (detecção de mudança)
//   mode=timelapse  — Composite Landsat true-color de um ano específico

var ee = require('@google/earthengine');

var CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

// Escala Landsat L2 SR
function scaleL2(img) {
  return img.select(['SR_B.*']).multiply(0.0000275).add(-0.2)
    .copyProperties(img, ['system:time_start']);
}

// Coleta Landsat filtrada por ano e cobertura de nuvens
function getLandsat(year, cloudMax) {
  cloudMax = cloudMax || 20;
  var start = year + '-01-01';
  var end   = year + '-12-31';

  if (year >= 2022) {
    return ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
      .filterDate(start, end)
      .filter(ee.Filter.lt('CLOUD_COVER', cloudMax))
      .map(function(img) { return scaleL2(img).select(['SR_B4','SR_B3','SR_B2','SR_B5','SR_B6','SR_B7'],['R','G','B','NIR','SWIR1','SWIR2']); });
  } else if (year >= 2013) {
    return ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
      .filterDate(start, end)
      .filter(ee.Filter.lt('CLOUD_COVER', cloudMax))
      .map(function(img) { return scaleL2(img).select(['SR_B4','SR_B3','SR_B2','SR_B5','SR_B6','SR_B7'],['R','G','B','NIR','SWIR1','SWIR2']); });
  } else if (year >= 2003) {
    return ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
      .filterDate(start, end)
      .filter(ee.Filter.lt('CLOUD_COVER', cloudMax))
      .map(function(img) { return scaleL2(img).select(['SR_B3','SR_B2','SR_B1','SR_B4','SR_B5','SR_B7'],['R','G','B','NIR','SWIR1','SWIR2']); });
  } else {
    return ee.ImageCollection('LANDSAT/LT05/C02/T1_L2')
      .filterDate(start, end)
      .filter(ee.Filter.lt('CLOUD_COVER', cloudMax))
      .map(function(img) { return scaleL2(img).select(['SR_B3','SR_B2','SR_B1','SR_B4','SR_B5','SR_B7'],['R','G','B','NIR','SWIR1','SWIR2']); });
  }
}

exports.handler = function(event, context, callback) {
  if (event.httpMethod === 'OPTIONS') {
    return callback(null, { statusCode: 204, headers: CORS, body: '' });
  }

  var p          = event.queryStringParameters || {};
  var mode       = p.mode       || 'ndvi';
  var year       = parseInt(p.year)      || new Date().getFullYear() - 1;
  var year2      = parseInt(p.year2)     || year - 5;   // para diffndvi
  var cloudMax   = parseInt(p.cloud)     || 20;

  var pk;
  try { pk = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY); }
  catch(e) { return send(callback, 500, { error: 'GEE_SERVICE_ACCOUNT_KEY nao configurada' }); }

  ee.data.authenticateViaPrivateKey(pk, function() {
    ee.initialize(null, null, function() {

      var col  = getLandsat(year, cloudMax);
      var med  = col.median();

      // ── NDVI ─────────────────────────────────────────────────────────────
      if (mode === 'ndvi') {
        var ndvi = med.normalizedDifference(['NIR','R']).rename('NDVI');
        ndvi.getMapId({
          min: -0.3, max: 0.85,
          palette: ['d73027','f46d43','fdae61','fee08b','ffffbf',
                    'd9ef8b','a6d96a','66bd63','1a9850','006837']
        }, function(mapId, err) {
          if (err) return send(callback, 500, { error: 'ndvi getMapId: ' + err });
          send(callback, 200, { tileUrl: mapId.urlFormat, mode:'ndvi', year:year, source:'Landsat-GEE' },
               { 'Cache-Control': 'public, max-age=1800' });
        });

      // ── EVI ──────────────────────────────────────────────────────────────
      } else if (mode === 'evi') {
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
          send(callback, 200, { tileUrl: mapId.urlFormat, mode:'evi', year:year, source:'Landsat-GEE' },
               { 'Cache-Control': 'public, max-age=1800' });
        });

      // ── NBR (cicatrizes de incêndio / risco de supressão) ─────────────────
      } else if (mode === 'nbr') {
        var nbr = med.normalizedDifference(['NIR','SWIR2']).rename('NBR');
        nbr.getMapId({
          min: -0.5, max: 0.9,
          palette: ['7a0403','d44d00','f5a623','ffffbe','c7e9b4','41b6c4','225ea8','0c2c84']
        }, function(mapId, err) {
          if (err) return send(callback, 500, { error: 'nbr getMapId: ' + err });
          send(callback, 200, { tileUrl: mapId.urlFormat, mode:'nbr', year:year, source:'Landsat-GEE' },
               { 'Cache-Control': 'public, max-age=1800' });
        });

      // ── NDWI (corpos d'água) ──────────────────────────────────────────────
      } else if (mode === 'ndwi') {
        var ndwi = med.normalizedDifference(['G','NIR']).rename('NDWI');
        ndwi.getMapId({
          min: -0.5, max: 0.5,
          palette: ['d7191c','fdae61','ffffbf','abd9e9','2c7bb6']
        }, function(mapId, err) {
          if (err) return send(callback, 500, { error: 'ndwi getMapId: ' + err });
          send(callback, 200, { tileUrl: mapId.urlFormat, mode:'ndwi', year:year, source:'Landsat-GEE' },
               { 'Cache-Control': 'public, max-age=1800' });
        });

      // ── DIFF NDVI (ano2 - ano1) ───────────────────────────────────────────
      } else if (mode === 'diffndvi') {
        var col2  = getLandsat(year2, cloudMax);
        var med2  = col2.median();
        var ndvi1 = med.normalizedDifference(['NIR','R']);
        var ndvi2 = med2.normalizedDifference(['NIR','R']);
        var diff  = ndvi2.subtract(ndvi1).rename('dNDVI');
        // positivo = ganho de vegetação; negativo = perda
        diff.getMapId({
          min: -0.5, max: 0.5,
          palette: ['7f0000','d73027','f46d43','fee08b','ffffbf',
                    'd9ef8b','66bd63','1a9850','004529']
        }, function(mapId, err) {
          if (err) return send(callback, 500, { error: 'diffndvi getMapId: ' + err });
          send(callback, 200, {
            tileUrl: mapId.urlFormat, mode:'diffndvi',
            yearBase: year2, yearComp: year, source:'Landsat-GEE'
          }, { 'Cache-Control': 'public, max-age=1800' });
        });

      // ── TIMELAPSE (composite true-color) ──────────────────────────────────
      } else if (mode === 'timelapse') {
        var rgb = med.select(['R','G','B'])
          .multiply(255).clamp(0,255).uint8();
        rgb.getMapId({ bands:['R','G','B'], min:0, max:255,
          gamma: 1.4
        }, function(mapId, err) {
          if (err) return send(callback, 500, { error: 'timelapse getMapId: ' + err });
          send(callback, 200, { tileUrl: mapId.urlFormat, mode:'timelapse', year:year, source:'Landsat-GEE' },
               { 'Cache-Control': 'public, max-age=3600' });
        });

      } else {
        send(callback, 400, { error: 'mode inválido: use ndvi|evi|nbr|ndwi|diffndvi|timelapse' });
      }

    }, function(e) { send(callback, 500, { error: 'GEE init: ' + e }); });
  }, function(e)   { send(callback, 500, { error: 'GEE auth: ' + e }); });
};
