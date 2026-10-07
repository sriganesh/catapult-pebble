/**
 * A stand-in for the PebbleKit JS sandbox: just enough localStorage,
 * navigator and XMLHttpRequest to run the phone-side modules under `node
 * --test`. Routes are matched on "METHOD url-substring".
 */

function install(routes) {
  var store = {};
  var calls = [];

  global.localStorage = {
    getItem: function (key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem: function (key, value) {
      store[key] = String(value);
    },
    removeItem: function (key) {
      delete store[key];
    }
  };

  global.navigator = { language: 'en-GB' };

  function MockXHR() {
    this.status = 0;
    this.readyState = 0;
    this.responseText = '';
  }
  MockXHR.prototype.open = function (method, url) {
    this.method = method;
    this.url = url;
  };
  MockXHR.prototype.setRequestHeader = function (name, value) {
    this.headers = this.headers || {};
    this.headers[name] = value;
  };
  MockXHR.prototype.send = function (body) {
    var self = this;
    calls.push({ method: this.method, url: this.url, body: body ? JSON.parse(body) : undefined,
                 headers: this.headers || {} });

    var handler = null;
    for (var i = 0; i < routes.length; i++) {
      if (self.method === routes[i].method && self.url.indexOf(routes[i].match) !== -1) {
        handler = routes[i];
        break;
      }
    }

    // Mirrors pypkjs: a failed connection sets status 0 and readyState DONE
    // and fires only readystatechange, with no error event. Code that works
    // against this mock works in the emulator.
    function done() {
      self.readyState = 4;
      if (self.onreadystatechange) self.onreadystatechange();
      if (self.onloadend) self.onloadend();
    }

    // A host that ends the request without ever setting readyState to DONE.
    // pypkjs does this when an internal error escapes its request layer.
    function endedWithoutReadyState() {
      if (self.onloadend) self.onloadend();
    }

    setTimeout(function () {
      if (!handler) { done(); return; }
      var result = typeof handler.reply === 'function'
        ? handler.reply(calls.length, self)
        : handler.reply;
      if (result === 'hang') { return; }  // never completes, never errors
      if (result === 'broken-host') { endedWithoutReadyState(); return; }
      if (result === 'network-error') { done(); return; }
      if (result === 'timeout') {
        if (self.ontimeout) self.ontimeout();
        return;
      }
      self.status = result.status;
      self.responseText = typeof result.body === 'string'
        ? result.body
        : JSON.stringify(result.body);
      done();
    }, 0);
  };

  global.XMLHttpRequest = MockXHR;

  return {
    calls: calls,
    store: store,
    reset: function () {
      calls.length = 0;
      for (var key in store) delete store[key];
    }
  };
}

module.exports = { install: install };
