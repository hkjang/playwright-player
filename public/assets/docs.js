window.ui = SwaggerUIBundle({
  url: window.__PW_PLAYER__.openApiUrl,
  // Keep documentation usable on intranets without contacting Swagger's public validator.
  validatorUrl: null,
  dom_id: '#swagger-ui',
  deepLinking: true,
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
  layout: 'StandaloneLayout',
  displayRequestDuration: true,
  defaultModelsExpandDepth: 2,
  defaultModelExpandDepth: 2,
  tryItOutEnabled: true
});
