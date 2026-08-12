# Auditoría GMB — GoodMax

Landing de una sola página (HTML/CSS/JS puro, sin frameworks) para que un
negocio pegue el link de su ficha de Google Maps y reciba un checklist
simple de qué está bien y qué le falta, con una invitación final a
contactar a GoodMax por WhatsApp.

## Estado actual

Esta es la etapa de **diseño y estructura**. La auditoría todavía **no lee
la ficha real de Google Maps**: `script.js` genera un resultado simulado
(pero estable para el mismo link, gracias a un generador con semilla) para
poder mostrar toda la interfaz funcionando de punta a punta.

## Cómo se audita cada ficha (por ahora)

Se evalúan 13 puntos:

- Fotos actualizadas
- Horarios completos
- Categoría correcta
- Web cargada
- WhatsApp cargado
- Publicaciones activas
- Descripción del negocio completa (con palabras clave del rubro)
- Servicios o productos cargados
- Categorías secundarias
- Área de servicio configurada
- Atributos del negocio completos (accesibilidad, delivery, retiro en local, etc.)
- Preguntas y respuestas (si el dueño responde)
- Reseñas (cantidad y si el negocio responde)

## Próximo paso: conectar la lectura real

Todo el punto de integración está aislado en una sola función,
`getAuditResult(url)` en `script.js`. Para conectar la lectura real de
Google Maps (API, scraping, backend propio, etc.) alcanza con reemplazar
el cuerpo de esa función, siempre devolviendo un array con el mismo
formato:

```js
{ id, title, okDesc, failDesc, ok }
```

## Cómo verlo

Abrir `index.html` directamente en el navegador, o servirlo con cualquier
servidor estático:

```bash
python3 -m http.server 8000
```
