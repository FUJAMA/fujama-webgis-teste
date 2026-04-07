var ee = require('@google/earthengine');

// Configurações dos seus rasters
var ASSETS = {
  orto1979: {
    id: 'users/SEU_USUARIO/fujama/ORTO1979',
    vis: { bands: ['b1', 'b2', 'b3'], min: 0, max: 255 }
  },
  mdt: {
    id: 'users/SEU_USUARIO/fujama/MDT_GERAL',
    vis: { min: 0, max: 1200, palette: ['#313695','#74add1','#ffffbf','#f46d43','#a50026'] }
  }
};

exports.handler = function(event, context, callback) {

  // Qual raster foi solicitado? ex: /.netlify/functions/gee-tiles?layer=orto1979
  var layer = event.queryStringParameters && event.queryStringParameters.layer;

  if (!layer || !ASSETS[layer]) {
    return callback(null, {
      statusCode: 400,
      body: JSON.stringify({ error: 'Parâmetro layer inválido. Use: orto1979 ou mdt' })
    });
  }

  // Chave do service account vem da variável de ambiente (nunca no código)
  var privateKey;
  try {
    privateKey = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY);
  } catch (e) {
    return callback(null, {
      statusCode: 500,
      body: JSON.stringify({ error: 'Variável GEE_SERVICE_ACCOUNT_KEY não configurada' })
    });
  }

  // Inicializa o GEE com o service account
  ee.data.authenticateViaPrivateKey(privateKey, function() {
    ee.initialize(null, null, function() {

      var asset = ASSETS[layer];
      var image = ee.Image(asset.id);

      // Gera o mapId com os parâmetros de visualização
      image.getMapId(asset.vis, function(mapId, error) {
        if (error) {
          return callback(null, {
            statusCode: 500,
            body: JSON.stringify({ error: error.toString() })
          });
        }

        callback(null, {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            // Cache de 50 minutos — o mapId dura ~1h
            'Cache-Control': 'public, max-age=3000'
          },
          body: JSON.stringify({
            tileUrl: mapId.urlFormat
          })
        });
      });

    }, function(error) {
      callback(null, {
        statusCode: 500,
        body: JSON.stringify({ error: 'Falha ao inicializar GEE: ' + error })
      });
    });
  }, function(error) {
    callback(null, {
      statusCode: 500,
      body: JSON.stringify({ error: 'Falha na autenticação: ' + error })
    });
  });
};
