// Replace an element's children, skipping null/false (Element.replaceChildren would render them as text).
export function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}
