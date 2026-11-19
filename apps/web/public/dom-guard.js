/*
 * MCPEmails DOM guard (2026-11-19). Loaded from app/layout.js before React.
 *
 * Browser page translators (Chrome and Edge Translate) replace each text node
 * with their own <font> elements. React still holds the original node, and the
 * next time it removes it or inserts next to it the browser throws
 * NotFoundError ("The node to be removed is not a child of this node"). The
 * whole app then falls to the error page. That is what users who translate the
 * dashboard saw after a failed inbox connection.
 *
 * Fix: when the node React names has been moved inside a translator wrapper
 * that is still under the same parent, act on that wrapper instead; when it is
 * gone entirely, do nothing. Every call React makes correctly is untouched.
 * Each recovery is reported once per page through public/ce.js
 * (kind "error", message "dom_guard:<method>").
 */
(function () {
  try {
    if (typeof Node !== 'function' || !Node.prototype || Node.prototype.__mcpeGuard) return;
    var proto = Node.prototype;
    proto.__mcpeGuard = 1;
    var removeChild = proto.removeChild;
    var insertBefore = proto.insertBefore;
    var reported = {};

    function report(method) {
      try {
        if (reported[method]) return;
        reported[method] = 1;
        setTimeout(function () {
          try {
            window.dispatchEvent(new ErrorEvent('error', { message: 'dom_guard:' + method }));
          } catch (_) {}
        }, 0);
      } catch (_) {}
    }

    // The direct child of `parent` that contains `node`, or null.
    function childHolding(parent, node) {
      var current = node;
      while (current && current.parentNode && current.parentNode !== parent) current = current.parentNode;
      return current && current.parentNode === parent ? current : null;
    }

    proto.removeChild = function (child) {
      if (child && child.parentNode !== this) {
        report('removeChild');
        var holder = childHolding(this, child);
        if (holder) return removeChild.call(this, holder);
        return child;
      }
      return removeChild.apply(this, arguments);
    };

    proto.insertBefore = function (node, reference) {
      if (reference && reference.parentNode !== this) {
        report('insertBefore');
        return insertBefore.call(this, node, childHolding(this, reference));
      }
      return insertBefore.apply(this, arguments);
    };
  } catch (_) {}
})();
