/**
 * The DOM inspector the errand browser runs in its own CDP isolated world. It reads DOM facts only (tag, role, visible
 * label, input type, autocomplete, name/id/label, enclosing form's submit button, bounding rect) and never page-provided
 * JS state, so page script cannot intercept or spoof it. Kept as plain source text because it is evaluated remotely.
 */
export const ERRAND_TARGET_WORLD = "goatcitadel-errand-inspect";

const TARGET_SCRIPT_BODY = String.raw`
  var MAX_TEXT = 120;
  var ONE_TIME_CODE = /otp|one.?time|verification code|2fa|mfa/i;
  var INTERACTIVE = 'a[href],button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="textbox"],[role="combobox"],[role="menuitem"],[role="tab"],[role="switch"],[role="option"],[contenteditable=""],[contenteditable="true"],[tabindex]';
  function clean(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  }
  function labelText(el) {
    var parts = [];
    var labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      labelled.split(/\s+/).forEach(function (id) {
        var ref = id && el.ownerDocument.getElementById(id);
        if (ref) parts.push(ref.textContent);
      });
    }
    if (el.labels) {
      for (var i = 0; i < el.labels.length; i += 1) parts.push(el.labels[i].textContent);
    }
    return clean(parts.join(" "));
  }
  function visibleText(el) {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute("type") || "").toLowerCase();
    var aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (tag === "input" && (type === "submit" || type === "button" || type === "reset")) {
      return clean(el.value || el.getAttribute("value") || type);
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return clean(labelText(el) || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name"));
    }
    return clean(el.innerText || el.textContent || el.getAttribute("title") || el.getAttribute("alt"));
  }
  function implicitRole(el) {
    var explicit = clean(el.getAttribute("role"));
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute("type") || "text").toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (tag === "input") {
      if (type === "checkbox" || type === "radio") return type;
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      if (type === "range") return "slider";
      return "textbox";
    }
    return "generic";
  }
  function submitTextFor(el) {
    var form = el.form || (el.closest ? el.closest("form") : null);
    if (!form) return undefined;
    var submit = form.querySelector('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]');
    return submit ? visibleText(submit) || undefined : undefined;
  }
  function isFrame(el) {
    var tag = el.tagName.toLowerCase();
    return tag === "iframe" || tag === "frame";
  }
  function frameDocument(el) {
    try {
      return el.contentDocument || null;
    } catch (error) {
      return null;
    }
  }
  function frameInset(el) {
    var style = getComputedStyle(el);
    return {
      x: el.clientLeft + (parseFloat(style.paddingLeft) || 0),
      y: el.clientTop + (parseFloat(style.paddingTop) || 0)
    };
  }
  function looksLikeClosedShadowHost(el) {
    return el.tagName.indexOf("-") !== -1 && !el.shadowRoot && el.children.length === 0;
  }
  function describe(el, x, y, ox, oy, opaque) {
    var tag = el.tagName.toLowerCase();
    var isInput = tag === "input";
    var type = isInput ? (el.getAttribute("type") || "text").toLowerCase() : undefined;
    var autocomplete = clean(el.getAttribute("autocomplete")).toLowerCase() || undefined;
    var identity = [el.getAttribute("name"), el.id, labelText(el), el.getAttribute("aria-label"), el.getAttribute("placeholder")].join(" ");
    var rect = el.getBoundingClientRect();
    var left = rect.left + ox;
    var top = rect.top + oy;
    var info = {
      x: x === undefined ? Math.round(left + rect.width / 2) : x,
      y: y === undefined ? Math.round(top + rect.height / 2) : y,
      tagName: tag,
      role: implicitRole(el),
      text: visibleText(el),
      isPasswordLike: type === "password" || (autocomplete !== undefined && autocomplete.indexOf("password") !== -1),
      isOneTimeCode: (autocomplete !== undefined && autocomplete.split(/\s+/).indexOf("one-time-code") !== -1) || ONE_TIME_CODE.test(identity),
      isOpaque: opaque || looksLikeClosedShadowHost(el),
      rect: { x: Math.round(left), y: Math.round(top), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
    if (type !== undefined) info.inputType = type;
    if (autocomplete !== undefined) info.autocomplete = autocomplete;
    var submitText = submitTextFor(el);
    if (submitText !== undefined) info.formSubmitText = submitText;
    return info;
  }
`;

/** An expression resolving the element at a viewport point, then the nearest interactive ancestor, to its description. */
export function buildDescribePointExpression(x: number, y: number): string {
  return `(function () {${TARGET_SCRIPT_BODY}
    var cx = ${JSON.stringify(x)}, cy = ${JSON.stringify(y)}, ox = 0, oy = 0, opaque = false;
    var hit = document.elementFromPoint(cx, cy);
    if (!hit) return null;
    for (var depth = 0; depth < 20; depth += 1) {
      if (hit.shadowRoot) {
        var inner = hit.shadowRoot.elementFromPoint(cx, cy);
        if (inner && inner !== hit) { hit = inner; continue; }
      }
      if (isFrame(hit)) {
        var doc = frameDocument(hit);
        if (!doc) { opaque = true; break; }
        var rect = hit.getBoundingClientRect();
        var inset = frameInset(hit);
        var fx = cx - rect.left - inset.x, fy = cy - rect.top - inset.y;
        var inside = doc.elementFromPoint(fx, fy);
        if (!inside || inside === doc.documentElement) break;
        ox += rect.left + inset.x; oy += rect.top + inset.y;
        cx = fx; cy = fy; hit = inside;
        continue;
      }
      break;
    }
    var target = hit.closest(INTERACTIVE) || hit;
    return describe(target, ${JSON.stringify(x)}, ${JSON.stringify(y)}, ox, oy, opaque);
  })()`;
}

/** An expression describing the focused element (descending into open shadow roots), or null when nothing is focused. */
export function buildDescribeFocusedExpression(): string {
  return `(function () {${TARGET_SCRIPT_BODY}
    var active = document.activeElement, ox = 0, oy = 0, opaque = false;
    function unfocused(el) { return !el || el === el.ownerDocument.body || el === el.ownerDocument.documentElement; }
    if (unfocused(active)) return null;
    for (var depth = 0; depth < 20; depth += 1) {
      if (active.shadowRoot && active.shadowRoot.activeElement) { active = active.shadowRoot.activeElement; continue; }
      if (isFrame(active)) {
        var doc = frameDocument(active);
        if (!doc) { opaque = true; break; }
        var inside = doc.activeElement;
        if (unfocused(inside)) break;
        var rect = active.getBoundingClientRect();
        var inset = frameInset(active);
        ox += rect.left + inset.x; oy += rect.top + inset.y;
        active = inside;
        continue;
      }
      break;
    }
    return describe(active, undefined, undefined, ox, oy, opaque);
  })()`;
}
