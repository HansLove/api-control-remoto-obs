/**
 * context-mic-content.js
 * Contenido del overlay "Micrófono de Contexto" (serie "Gobierno de Ficción").
 *
 * MODO MANUAL: cada slide se dispara desde el control móvil; no rota solo.
 * Lo consume context-mic-overlay.html (OBS Browser Source, vertical 9:16).
 *
 * ── Cómo agregar un episodio nuevo ──────────────────────────────────────────
 * Solo añade un paquete con una clave nueva ("4", "5", …) con el mismo esquema.
 * No hay que tocar el HTML ni el servidor: el control manda {pkg:"4", index:N}.
 *
 * Esquema de cada slide:
 *   title   → encabezado de la tarjeta (debajo del rótulo "CONTEXTO")
 *   context → cuerpo, texto grande y legible en vertical
 *   cta     → se usa como CONTADOR ("Verificado X de N")
 *   link    → referencia (no se muestra como botón en 9:16; queda por si acaso)
 *   image   → opcional: ruta de un PNG (ej. "grafica-gasolina.png") a mostrar
 *             junto a la tarjeta. Déjalo fuera si el slide no lleva gráfica.
 */

window.CONTEXT_MIC = {
  "3": {
    label: "Micrófono de Contexto · Gasolina",
    slides: [
      {
        title: "CONTEXTO · Gasolina barata",
        context: "Desde 2014, el litro fue más caro en México cada año. Hoy casi empatan solo por la crisis de precios en EE.UU.",
        cta: "Verificado 1 de 4",
        link: "https://aarontolentino.com/"
        // image: "grafica-gasolina.png"  // ← pon aquí tu PNG para el Demo 1
      },
      {
        title: "CONTEXTO · Autosuficiencia",
        context: "Más de la mitad de la gasolina de México es importada, principalmente de Estados Unidos.",
        cta: "Verificado 2 de 4",
        link: "https://aarontolentino.com/"
      },
      {
        title: "CONTEXTO · ¿Culpa del petróleo?",
        context: "Impuesto federal EE.UU. ~0.90 MXN/L, congelado desde 1993. IEPS México ~6.40 MXN/L más IVA.",
        cta: "Verificado 3 de 4",
        link: "https://aarontolentino.com/"
      },
      {
        title: "CONTEXTO · Salario mínimo",
        context: "1 hora de mínimo compra ~2.5 litros en la frontera mexicana y ~12 litros en Arizona.",
        cta: "Verificado 4 de 4",
        link: "https://aarontolentino.com/"
      }
    ]
  }
};
