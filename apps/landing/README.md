# Landing

La página guarda el correo del formulario en una hoja de Google. El servidor valida la dirección y hace POST a un web app de Apps Script. No manda correo a quien se registra y no usa servicios de pago.

La URL se lee de `LANDING_SHEETS_WEBHOOK_URL`. Si falta, o no es `https`, el formulario dice que el envío no está configurado y no guarda nada.

## Hoja y script

1. Crea una hoja con la primera fila: `fecha`, `email`, `origen`.
2. Extensiones → Apps Script, y pega esto:

```javascript
function doPost(e) {
  var sheet = SpreadsheetApp.getActive().getSheets()[0];
  var data = JSON.parse(e.postData.contents);
  sheet.appendRow([textCell(data.submittedAt), textCell(data.email), textCell(data.origin)]);
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}

function textCell(value) {
  var text = String(value == null ? "" : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}
```

3. Implementar → Nueva implementación → Tipo: aplicación web.
4. Ejecutar como: Yo. Quién tiene acceso: Cualquier persona. El script solo añade una fila; no envía correo.
5. Copia la URL que termina en `/exec`. Tiene esta forma, con tu id de implementación: `https://script.google.com/macros/s/DEPLOYMENT_ID/exec`.
6. Ponla en `LANDING_SHEETS_WEBHOOK_URL` en el entorno del servidor. No la subas al repositorio. `.env.example` deja la variable vacía.
