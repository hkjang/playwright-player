window.ui = SwaggerUIBundle({
  url: window.__PW_PLAYER__.openApiUrl,
  dom_id: '#swagger-ui',
  deepLinking: true,
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
  layout: 'StandaloneLayout',
  displayRequestDuration: true,
  defaultModelsExpandDepth: 2,
  defaultModelExpandDepth: 2,
  tryItOutEnabled: true
});
