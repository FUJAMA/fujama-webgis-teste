const ee = require('@google/earthengine');
exports.handler = async (event) => {
  const lat = parseFloat(event.queryStringParameters.lat);
  const lng = parseFloat(event.queryStringParameters.lng);
  // Autentica GEE e retorna elevação do ponto
  const elevation = await getElevationFromGEE(lat, lng);
  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ elevation })
  };
};
