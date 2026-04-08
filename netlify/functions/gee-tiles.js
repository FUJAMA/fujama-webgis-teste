// netlify/functions/gee-tiles.js
// Serve URLs de tile do Google Earth Engine para os rasters do projeto FUJAMA.
// Suporta os layers: orto1979 | mdt

var ee = require('@google/earthengine');

var ORTO1979_ID = 'projects/webgis-492011/assets/ORTO1979';
var MDT_ID      = 'projects/webgis-492011/assets/MDT_GERAL';

// Paleta hipsométrica (mesma do código original do mapa)
var MDT_PALETTE = [
  '313695', '4575b4', '74add1', 'abd9e9',
  'ffffbf', 'fee090', 'fdae61', 'f46d43',
  'd73027', 'a50026'
];

var CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function send(callback, status, body, extra) {
  callback(null, {
    statusCode: status,
    headers: Object.assign({}, CORS, extra || {}),
    body: JSON.stringify(body)
  });
}

exports.handler = function(event, context, callback) {

  if (event.httpMethod === 'OPTIONS') {
    return callback(null, { statusCode: 204, headers: CORS, body: '' });
  }

  var params = event.queryStringParameters || {};
  var layer  = params.layer;

  if (layer !== 'orto1979' && layer !== 'mdt') {
    return send(callback, 400, { error: 'layer deve ser orto1979 ou mdt' });
  }

  var privateKey;
  try {
    privateKey = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY);
  } catch (e) {
    return send(callback, 500, { error: 'GEE_SERVICE_ACCOUNT_KEY nao configurada' });
  }

  ee.data.authenticateViaPrivateKey(privateKey, function() {
    ee.initialize(null, null, function() {

      // ── Ortomosaico 1979 ─────────────────────────────────────────────────
      if (layer === 'orto1979') {
        var image = ee.Image(ORTO1979_ID);

        // Detecta numero real de bandas antes de montar vis params
        image.getInfo(function(info, infoErr) {
          var nbands = (info && info.bands) ? info.bands.length : 1;
          var vis;

          if (nbands >= 3) {
            var bnames = info.bands.map(function(b) { return b.id; });
            vis = { bands: [bnames[0], bnames[1], bnames[2]], min: 0, max: 255 };
          } else {
            // 1 banda: escala de cinzas
            var bname = (info && info.bands && info.bands[0]) ? info.bands[0].id : 'b1';
            vis = { bands: [bname], min: 0, max: 255, palette: ['000000', 'ffffff'] };
          }

          image.getMapId(vis, function(mapId, err) {
            if (err) return send(callback, 500, { error: 'orto1979 getMapId: ' + err });
            send(callback, 200, { tileUrl: mapId.urlFormat },
                 { 'Cache-Control': 'public, max-age=3000' });
          });
        });

      // ── MDT com hillshade + paleta hipsometrica ──────────────────────────
      } else {
        var dem = ee.Image(MDT_ID).select(0);

        dem.reduceRegion({
          reducer:    ee.Reducer.percentile([2, 98]),
          scale:      30,
          maxPixels:  1e8,
          bestEffort: true
        }).evaluate(function(stats, statsErr) {

          var vmin = 0, vmax = 1800;
          if (!statsErr && stats) {
            Object.keys(stats).forEach(function(k) {
              var v = stats[k];
              if (!isFinite(v)) return;
              if (k.slice(-3) === '_p2'  || k === 'p2')  vmin = v;
              if (k.slice(-4) === '_p98' || k === 'p98') vmax = v;
            });
          }

          var hs      = ee.Terrain.hillshade(dem, 315, 45);
          var colored = dem.visualize({ min: vmin, max: vmax, palette: MDT_PALETTE });
          var hsNorm  = hs.divide(255).multiply(1.4).clamp(0, 1.4);
          var blended = colored.multiply(hsNorm).clamp(0, 255).uint8()
                          .rename(['vis-red', 'vis-green', 'vis-blue']);

          blended.getMapId({ bands: ['vis-red','vis-green','vis-blue'], min: 0, max: 255 },
            function(mapId, err) {
              if (err) {
                dem.getMapId({ min: vmin, max: vmax, palette: MDT_PALETTE },
                  function(mapId2, err2) {
                    if (err2) return send(callback, 500, { error: 'mdt getMapId fallback: ' + err2 });
                    send(callback, 200, { tileUrl: mapId2.urlFormat },
                         { 'Cache-Control': 'public, max-age=3000' });
                  }
                );
                return;
              }
              send(callback, 200, { tileUrl: mapId.urlFormat },
                   { 'Cache-Control': 'public, max-age=3000' });
            }
          );
        });
      }

    }, function(err) { send(callback, 500, { error: 'GEE init: '   + err }); });
  }, function(err)   { send(callback, 500, { error: 'GEE auth: '   + err }); });
};
