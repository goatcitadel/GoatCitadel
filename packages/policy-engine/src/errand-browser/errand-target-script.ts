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
  function describe(el, x, y) {
    var tag = el.tagName.toLowerCase();
    var isInput = tag === "input";
    var type = isInput ? (el.getAttribute("type") || "text").toLowerCase() : undefined;
    var autocomplete = clean(el.getAttribute("autocomplete")).toLowerCase() || undefined;
    var identity = [el.getAttribute("name"), el.id, labelText(el), el.getAttribute("aria-label"), el.getAttribute("placeholder")].join(" ");
    var rect = el.getBoundingClientRect();
    var info = {
      x: x === undefined ? Math.round(rect.left + rect.width / 2) : x,
      y: y === undefined ? Math.round(rect.top + rect.height / 2) : y,
      tagName: tag,
      role: implicitRole(el),
      text: visibleText(el),
      isPasswordLike: type === "password" || (autocomplete !== undefined && autocomplete.indexOf("password") !== -1),
      isOneTimeCode: (autocomplete !== undefined && autocomplete.split(/\s+/).indexOf("one-time-code") !== -1) || ONE_TIME_CODE.test(identity),
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
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
    var hit = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    if (!hit) return null;
    var target = hit.closest(INTERACTIVE) || hit;
    return describe(target, ${JSON.stringify(x)}, ${JSON.stringify(y)});
  })()`;
}

/** An expression describing the focused element (descending into open shadow roots), or null when nothing is focused. */
export function buildDescribeFocusedExpression(): string {
  return `(function () {${TARGET_SCRIPT_BODY}
    var active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    if (!active || active === document.body || active === document.documentElement) return null;
    return describe(active, undefined, undefined);
  })()`;
}
