// netlify/functions/gee-analise.js
// Análises espectrais próprias via Google Earth Engine.
// Segue exatamente o mesmo padrão de gee-elevation.js (singleton withEE).
//
// Modos:
//   ?mode=ndvi     &year=YYYY &cloud=N   → NDVI anual
//   ?mode=evi      &year=YYYY &cloud=N   → EVI anual
//   ?mode=nbr      &year=YYYY &cloud=N   → NBR (cicatrizes/incêndio)
//   ?mode=ndwi     &year=YYYY &cloud=N   → NDWI (água/umidade)
//   ?mode=diffndvi &year=YYYY &year2=YYYY &cloud=N → Δ NDVI entre dois anos
//   ?mode=timelapse&year=YYYY &cloud=N   → True-color Landsat como tile

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

// ── Singleton de inicialização (igual ao gee-elevation.js) ───────────────────
var _ready   = false;
var _initErr = null;

function withEE(pk, fn, cb) {
  if (_ready)   { fn(); return; }
  if (_initErr) { send(cb, 500, { error: 'GEE init anterior falhou: ' + _initErr }); return; }

  ee.data.authenticateViaPrivateKey(pk, function() {
    ee.initialize(null, null, function() {
      _ready = true;
      fn();
    }, function(err) { _initErr = err; send(cb, 500, { error: 'GEE init: ' + err }); });
  }, function(err) { _initErr = err; send(cb, 500, { error: 'GEE auth: ' + err }); });
}

// ── Monta coleção Landsat L2 escalada para o ano, renomeia bandas ─────────────
function getLandsat(year, cloudMax) {
  var s = year + '-01-01';
  var e = year + '-12-31';
  var c = cloudMax || 20;

  var scale = function(img) {
    return img.select(['SR_B.*'])
      .multiply(0.0000275).add(-0.2)
      .copyProperties(img, ['system:time_start']);
  };

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
  // Landsat 5 (1985–2002)
  return ee.ImageCollection('LANDSAT/LT05/C02/T1_L2')
    .filterDate(s, e).filter(ee.Filter.lt('CLOUD_COVER', c))
    .map(function(img) {
      return scale(img).select(
        ['SR_B3','SR_B2','SR_B1','SR_B4','SR_B5','SR_B7'],
        ['R',    'G',    'B',    'NIR',  'SWIR1','SWIR2']);
    });
}

// ── Handler principal ─────────────────────────────────────────────────────────
exports.handler = function(event, context, callback) {

  if (event.httpMethod === 'OPTIONS') {
    return callback(null, { statusCode: 204, headers: CORS, body: '' });
  }

  var p      = event.queryStringParameters || {};
  var mode   = p.mode  || 'ndvi';
  var year   = parseInt(p.year)   || (new Date().getFullYear() - 1);
  var year2  = parseInt(p.year2)  || (year - 5);
  var cloud  = parseInt(p.cloud)  || 20;

  var VALID_MODES = ['ndvi','evi','nbr','ndwi','diffndvi','timelapse'];
  if (VALID_MODES.indexOf(mode) === -1) {
    return send(callback, 400, { error: 'mode inválido. Use: ' + VALID_MODES.join(' | ') });
  }
  if (year < 1985 || year > 2025) {
    return send(callback, 400, { error: 'year fora do intervalo 1985-2025' });
  }

  var pk;
  try { pk = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY); }
  catch(e) { return send(callback, 500, { error: 'GEE_SERVICE_ACCOUNT_KEY nao configurada' }); }

  withEE(pk, function() {

    var med   = getLandsat(year, cloud).median();
    var CACHE = { 'Cache-Control': 'public, max-age=3600' };

    if (mode === 'ndvi') {
      var ndvi = med.normalizedDifference(['NIR','R']).rename('NDVI');
      ndvi.getMapId({
        min: -0.3, max: 0.85,
        palette: ['d73027','f46d43','fdae61','fee08b','ffffbf',
                  'd9ef8b','a6d96a','66bd63','1a9850','006837']
      }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'ndvi getMapId: ' + err });
        send(callback, 200, { tileUrl: mapId.urlFormat, mode:'ndvi', year:year }, CACHE);
      });

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
        send(callback, 200, { tileUrl: mapId.urlFormat, mode:'evi', year:year }, CACHE);
      });

    } else if (mode === 'nbr') {
      var nbr = med.normalizedDifference(['NIR','SWIR2']).rename('NBR');
      nbr.getMapId({
        min: -0.5, max: 0.9,
        palette: ['7a0403','d44d00','f5a623','ffffbe','c7e9b4','41b6c4','225ea8','0c2c84']
      }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'nbr getMapId: ' + err });
        send(callback, 200, { tileUrl: mapId.urlFormat, mode:'nbr', year:year }, CACHE);
      });

    } else if (mode === 'ndwi') {
      var ndwi = med.normalizedDifference(['G','NIR']).rename('NDWI');
      ndwi.getMapId({
        min: -0.5, max: 0.5,
        palette: ['d7191c','fdae61','ffffbf','abd9e9','2c7bb6']
      }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'ndwi getMapId: ' + err });
        send(callback, 200, { tileUrl: mapId.urlFormat, mode:'ndwi', year:year }, CACHE);
      });

    } else if (mode === 'diffndvi') {
      var base = Math.min(year, year2);
      var comp = Math.max(year, year2);

      if (base < 1985 || comp > 2025 || base === comp) {
        return send(callback, 400, { error: 'Anos invalidos para diffndvi' });
      }

      var medBase = getLandsat(base, cloud).median();
      var medComp = getLandsat(comp, cloud).median();
      var ndviBase = medBase.normalizedDifference(['NIR','R']);
      var ndviComp = medComp.normalizedDifference(['NIR','R']);
      var diff     = ndviComp.subtract(ndviBase).rename('dNDVI');

      diff.getMapId({
        min: -0.5, max: 0.5,
        palette: ['7f0000','d73027','f46d43','fee08b','ffffbf',
                  'd9ef8b','66bd63','1a9850','004529']
      }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'diffndvi getMapId: ' + err });
        send(callback, 200, {
          tileUrl: mapId.urlFormat, mode:'diffndvi',
          yearBase: base, yearComp: comp
        }, CACHE);
      });

    } else if (mode === 'timelapse') {
      var rgb = med.select(['R','G','B'])
        .multiply(255).clamp(0, 255).uint8();
      rgb.getMapId({ bands: ['R','G','B'], min: 0, max: 255, gamma: 1.4 },
        function(mapId, err) {
          if (err) return send(callback, 500, { error: 'timelapse getMapId: ' + err });
          send(callback, 200, { tileUrl: mapId.urlFormat, mode:'timelapse', year:year }, CACHE);
        });
    }

  }, callback);
};
