/* Mock Facebook JS SDK — replaces connect.facebook.net/.../all.js entirely.
 * The real app only uses a small surface; we implement exactly that and
 * resolve everything locally so the game boots into offline "classic" mode.
 * No network requests are ever made by this file. */

window.FB = (function () {
  var FAKE_USER_ID = "1234567890";
  var FAKE_ACCESS_TOKEN = "MOCK_ACCESS_TOKEN_DEADBEEF";
  var FAKE_EXPIRES_IN = 5183941;

  function fakeResponse() {
    return {
      status: "connected",
      authResponse: {
        accessToken: FAKE_ACCESS_TOKEN,
        expiresIn: FAKE_EXPIRES_IN,
        signedRequest: "MOCK_SIGNED_REQUEST_DEADBEEF",
        userID: FAKE_USER_ID,
        secret: "MOCK_SECRET_DEADBEEF",
      },
    };
  }

  function callMaybe(cb) {
    if (typeof cb === "function") cb(fakeResponse());
  }

  var FB = {
    init: function (config) {
      FB.__config = config || {};
    },

    getLoginStatus: function (cb) {
      callMaybe(cb);
      return fakeResponse();
    },

    getUserID: function () {
      return FAKE_USER_ID;
    },

    getAccessToken: function () {
      return FAKE_ACCESS_TOKEN;
    },

    getAuthResponse: function () {
      return fakeResponse().authResponse;
    },

    login: function (cb) {
      callMaybe(cb);
      return fakeResponse();
    },

    logout: function (cb) {
      if (cb) cb({});
    },

    getLoginStatusFromServer: function (cb) {
      callMaybe(cb);
    },

    api: function (path, cb) {
      // /me/permissions -> permissions all granted; everything else -> empty success
      if (typeof cb === "function") {
        if (/\/me\/permissions/.test(path || "")) {
          cb({ data: [{ permission: "publish_stream", status: "granted" }, { permission: "user_friends", status: "granted" }] });
        } else {
          cb({ data: [], id: FAKE_USER_ID });
        }
      }
      return Promise.resolve({ data: [] });
    },

    ui: function (opts, cb) {
      if (typeof cb === "function") cb({ success: true });
      return Promise.resolve({ success: true });
    },

    hideFlashCallback: function () {},

    Event: {
      subscribe: function () {},
      unsubscribe: function () {},
      clearCache: function () {},
    },

    Canvas: {
      setSize: function () {},
      setAutoGrow: function () {},
      setDoneLoading: function () {},
      setUrlHandler: function () {},
      getPageInfo: function (cb) {
        if (cb) cb({ clientWidth: 940, clientHeight: 570, rowHeight: 570, screenTop: 0, screenLeft: 0, scrollX: 0, scrollY: 0 });
      },
      startTimer: function () {},
      stopTimer: function () {},
      scrollTo: function () {},
      Plugin: {
        showPluginElement: function () {},
        hidePluginElement: function () {},
      },
      Prefetcher: {
        addStaticResource: function () {},
        setCollectionMode: function () {},
      },
    },

    CanvasIFrame: null,

    getReferrerLink: function () {
      return "#";
    },

    AppEvents: (function () {
      var api = {};
      ["activateApp", "clearAppVersion", "clearUserID", "logEvent", "logPageView",
       "logPurchase", "setAppVersion", "setUserID", "updateUserProperties",
       "getAppVersion", "getUserID",
      ].forEach(function (name) {
        api[name] = function () { return; };
      });
      api.EventNames = {
        MOBILE_APP_INSTALL: "MOBILE_APP_INSTALL",
        CUSTOM: "CUSTOM",
      };
      api.ParameterNames = {};
      return api;
    })(),

    XFBML: {
      parse: function () {},
    },

    addFriend: function () {},
    publish: function () {},
    share: function () {},
    initControls: function () {},
    __buffer: { replay: function () { return; }, calls: [], opts: null },
  };

  return FB;
})();
