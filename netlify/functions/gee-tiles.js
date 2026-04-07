// netlify/functions/gee-tiles.js
// Serve URLs de tile do Google Earth Engine para os rasters do projeto FUJAMA.
// Suporta os layers: orto1979 | mdt
// O MDT é renderizado com hillshade (sombreado de relevo) + paleta hipsométrica via ee.Terrain.hillshade()

var ee = require('@google/earthengine');

// ── Configuração dos assets ──────────────────────────────────────────────────
// Substitua pelos caminhos reais dos seus assets no GEE:
var ASSETS = {
  orto1979: {
    id: 'projects/webgis-492011/assets/ORTO1979',
    getVis: function(image) {
      // Orto 1979: RGB (ou escala de cinzas se 1 banda)
      var info = image.getInfo();
      var nbands = info && info.bands ? info.bands.length : 1;
      if (nbands >= 3) {
        return { bands: ['b1'], min: 0, max: 255 };
      }
      return { bands: ['b1'], min: 0, max: 255, palette: ['000000', 'ffffff'] };
    }
  },
  mdt: {
    id: 'projects/webgis-492011/assets/MDT_GERAL',
    getVis: null  // calculado dinamicamente com hillshade
  }
};

// ── Paleta hipsométrica (mesma do código original) ──────────────────────────
// Corresponde a: 0%=#313695  12%=#74add1  30%=#ffffbf  50%=#f46d43  68%=#d73027  100%=#a50026
var MDT_PALETTE = [
  '313695', '4575b4', '74add1', 'abd9e9',
  'ffffbf', 'fee090', 'fdae61', 'f46d43',
  'd73027', 'a50026'
];

exports.handler = function(event, context, callback) {

  // CORS — permite chamadas do GitHub Pages e do próprio Netlify
  var origin = (event.headers && event.headers.origin) || '*';
  var corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Preflight OPTIONS
  if (event.httpMethod === 'OPTIONS') {
    return callback(null, { statusCode: 204, headers: corsHeaders, body: '' });
  }

  // Parâmetro ?layer=
  var params = event.queryStringParameters || {};
  var layer = params.layer;

  if (!layer || !ASSETS[layer]) {
    return callback(null, {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Parâmetro layer inválido. Use: orto1979 ou mdt' })
    });
  }

  // Chave do service account vem da variável de ambiente
  var privateKey;
  try {
    privateKey = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY);
  } catch (e) {
    return callback(null, {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'GEE_SERVICE_ACCOUNT_KEY não configurada ou inválida' })
    });
  }

  // Inicializa GEE com service account
  ee.data.authenticateViaPrivateKey(privateKey, function() {
    ee.initialize(null, null, function() {

      var assetId = ASSETS[layer].id;

      if (layer === 'orto1979') {
        // ── Ortomosaico 1979 ──────────────────────────────────────────────
        var image = ee.Image(assetId);
        var vis = { bands: ['b1', 'b2', 'b3'], min: 0, max: 255 };

        image.getMapId(vis, function(mapId, err) {
          if (err) {
            return callback(null, {
              statusCode: 500,
              headers: corsHeaders,
              body: JSON.stringify({ error: 'GEE getMapId orto1979: ' + err.toString() })
            });
          }
          return callback(null, {
            statusCode: 200,
            headers: Object.assign({}, corsHeaders, { 'Cache-Control': 'public, max-age=3000' }),
            body: JSON.stringify({ tileUrl: mapId.urlFormat })
          });
        });

      } else if (layer === 'mdt') {
        // ── MDT com hillshade + paleta hipsométrica ───────────────────────
        //
        // Pipeline GEE:
        //  1. Carrega o DEM
        //  2. Calcula hillshade (azimute 315°, altitude 45°) → imagem 0–255
        //  3. Normaliza o DEM para 0–255 com percentis reais
        //  4. Aplica paleta hipsométrica ao DEM normalizado
        //  5. Blende hillshade (multiplicativo) sobre a paleta
        //  6. Exporta como RGB
        //
        var dem = ee.Image(assetId).select(0);

        // Percentis reais da área (mais robusto que min/max absoluto)
        var stats = dem.reduceRegion({
          reducer: ee.Reducer.percentile([2, 98]),
          scale: 30,
          maxPixels: 1e8,
          bestEffort: true
        });

        // Usa evaluate para obter os valores e montar a visualização
        stats.evaluate(function(statsInfo, statsErr) {

          // Fallback se evaluate falhar
          var vmin = 0, vmax = 1800;
          if (!statsErr && statsInfo) {
            var keys = Object.keys(statsInfo);
            // As chaves serão algo como "b1_p2" e "b1_p98"
            keys.forEach(function(k) {
              if (k.indexOf('p2') !== -1 && isFinite(statsInfo[k]))  vmin = statsInfo[k];
              if (k.indexOf('p98') !== -1 && isFinite(statsInfo[k])) vmax = statsInfo[k];
            });
          }

          // 1. Hillshade (ee.Terrain retorna 0–255 uint8)
          var hillshade = ee.Terrain.hillshade(dem, 315, 45);

          // 2. DEM normalizado 0–1
          var demNorm = dem.subtract(vmin).divide(vmax - vmin).clamp(0, 1);

          // 3. Paleta hipsométrica aplicada ao DEM normalizado (visualize → RGB 0–255)
          var colored = demNorm.multiply(255).uint8().visualize({
            min: 0, max: 255,
            palette: MDT_PALETTE
          });

          // 4. Hillshade normalizado 0–1 para blending
          var hsNorm = hillshade.divide(255).multiply(1.6).clamp(0, 1.5);

          // 5. Blend: cada canal RGB da paleta multiplicado pelo hillshade normalizado
          //    Resultado: zonas iluminadas ficam claras, zonas de sombra escurecem
          var r = colored.select('vis-red').divide(255).multiply(hsNorm).multiply(255).clamp(0, 255).uint8();
          var g = colored.select('vis-green').divide(255).multiply(hsNorm).multiply(255).clamp(0, 255).uint8();
          var b = colored.select('vis-blue').divide(255).multiply(hsNorm).multiply(255).clamp(0, 255).uint8();

          var blended = ee.Image.rgb(r, g, b);

          blended.getMapId({ bands: ['vis-red', 'vis-green', 'vis-blue'] }, function(mapId, err) {
            if (err) {
              // Tenta fallback sem blend (só paleta)
              dem.getMapId({ min: vmin, max: vmax, palette: MDT_PALETTE }, function(mapId2, err2) {
                if (err2) {
                  return callback(null, {
                    statusCode: 500,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: 'GEE getMapId mdt: ' + (err2 || err).toString() })
                  });
                }
                return callback(null, {
                  statusCode: 200,
                  headers: Object.assign({}, corsHeaders, { 'Cache-Control': 'public, max-age=3000' }),
                  body: JSON.stringify({ tileUrl: mapId2.urlFormat })
                });
              });
              return;
            }
            return callback(null, {
              statusCode: 200,
              headers: Object.assign({}, corsHeaders, { 'Cache-Control': 'public, max-age=3000' }),
              body: JSON.stringify({ tileUrl: mapId.urlFormat })
            });
          });
        });
      }

    }, function(err) {
      callback(null, {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Falha ao inicializar GEE: ' + err })
      });
    });
  }, function(err) {
    callback(null, {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Falha na autenticação GEE: ' + err })
    });
  });
};
