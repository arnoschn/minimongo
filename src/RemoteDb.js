/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
let RemoteDb;
const _ = require('lodash');
const $ = require('jquery');
const async = require('async');
const utils = require('./utils');
const jQueryHttpClient = require('./jQueryHttpClient');
const quickfind = require('./quickfind');

module.exports = (RemoteDb = class RemoteDb {
  // Url must have trailing /
  // useQuickFind enables the quickfind protocol for finds
  constructor(url, client, httpClient, useQuickFind) {
    if (useQuickFind == null) { useQuickFind = false; }
    this.url = url;
    this.client = client;
    this.collections = {};
    this.httpClient = httpClient;
    this.useQuickFind = useQuickFind;
  }

  // Can specify url of specific collection as option
  addCollection(name, options, success, error) {
    if (options == null) { options = {}; }
    if (_.isFunction(options)) {
      [options, success, error] = Array.from([{}, options, success]);
    }

    const url = options.url || (this.url + name);

    const collection = new Collection(name, url, this.client, this.httpClient, this.useQuickFind);
    this[name] = collection;
    this.collections[name] = collection;
    if (success != null) { return success(); }
  }

  removeCollection(name, success, error) {
    delete this[name];
    delete this.collections[name];
    if (success != null) { return success(); }
  }

  getCollectionNames() { return _.keys(this.collections); }
});

// Remote collection on server
class Collection {
  constructor(name, url, client, httpClient, useQuickFind) {
    this.name = name;
    this.url = url;
    this.client = client;
    this.httpClient = httpClient || jQueryHttpClient;
    this.useQuickFind = useQuickFind;
  }

  // error is called with jqXHR
  find(selector, options) {
    if (options == null) { options = {}; }
    return{ fetch: (success, error) => {
      // Create url
      const params = {};
      if (options.sort) {
        params.sort = JSON.stringify(options.sort);
      }
      if (options.limit) {
        params.limit = options.limit;
      }
      if (options.skip) {
        params.skip = options.skip;
      }
      if (options.fields) {
        params.fields = JSON.stringify(options.fields);
      }
      if (this.client) {
        params.client = this.client;
      }
      params.selector = JSON.stringify(selector || {});

      // Add timestamp for Android 2.3.6 bug with caching
      if ((typeof navigator !== 'undefined' && navigator !== null) && (navigator.userAgent.toLowerCase().indexOf('android 2.3') !== -1)) {
        params._ = new Date().getTime();
      }

      // If in quickfind and localData present and (no fields option or _rev included) and not (limit with no sort), use quickfind
      if (this.useQuickFind && options.localData && (!options.fields || options.fields._rev) && !(options.limit && !options.sort)) {
        return this.httpClient("POST", this.url + "/quickfind", params, quickfind.encodeRequest(options.localData), encodedResponse => {
          return success(quickfind.decodeResponse(encodedResponse, options.localData, options.sort));
        }
        , error);
      } else {
        return this.httpClient("GET", this.url, params, null, success, error);
      }
    }
  };
  }

  // error is called with jqXHR
  // Note that findOne is not used by HybridDb, but rather find with limit is used
  findOne(selector, options, success, error) {
    if (options == null) { options = {}; }
    if (_.isFunction(options)) {
      [options, success, error] = Array.from([{}, options, success]);
    }

    // Create url
    const params = {};
    if (options.sort) {
      params.sort = JSON.stringify(options.sort);
    }
    params.limit = 1;
    if (this.client) {
      params.client = this.client;
    }
    params.selector = JSON.stringify(selector || {});

    // Add timestamp for Android 2.3.6 bug with caching
    if ((typeof navigator !== 'undefined' && navigator !== null) && (navigator.userAgent.toLowerCase().indexOf('android 2.3') !== -1)) {
      params._ = new Date().getTime();
    }

    return this.httpClient("GET", this.url, params, null, function(results) {
      if (results && (results.length > 0)) {
        return success(results[0]);
      } else {
        return success(null);
      }
    }
    , error);
  }

  // error is called with jqXHR
  upsert(docs, bases, success, error) {
    let items;
    [items, success, error] = Array.from(utils.regularizeUpsert(docs, bases, success, error));

    if (!this.client) {
      throw new Error("Client required to upsert");
    }

    const results = [];

    // Check if bases present
    const basesPresent = _.compact(_.pluck(items, "base")).length > 0;

    const params = { client: this.client };

    // Add timestamp for Android 2.3.6 bug with caching
    if ((typeof navigator !== 'undefined' && navigator !== null) && (navigator.userAgent.toLowerCase().indexOf('android 2.3') !== -1)) {
      params._ = new Date().getTime();
    }

    // Handle single case
    if (items.length === 1) {
      // POST if no base, PATCH otherwise
      if (basesPresent) {
        return this.httpClient("PATCH", this.url, params, items[0], function(result) {
          if (_.isArray(docs)) {
            return success([result]);
          } else {
            return success(result);
          }
        }
        , function(err) {
          if (error) { return error(err); }
        });
      } else {
        return this.httpClient("POST", this.url, params, items[0].doc, function(result) {
          if (_.isArray(docs)) {
            return success([result]);
          } else {
            return success(result);
          }
        }
        , function(err) {
          if (error) { return error(err); }
        });
      }
    } else {
      // POST if no base, PATCH otherwise
      if (basesPresent) {
        return this.httpClient("PATCH", this.url, params, { doc: _.pluck(items, "doc"), base: _.pluck(items, "base") }, result => success(result)
        , function(err) {
          if (error) { return error(err); }
        });
      } else {
        return this.httpClient("POST", this.url, params, _.pluck(items, "doc"), result => success(result)
        , function(err) {
          if (error) { return error(err); }
        });
      }
    }
  }


  // error is called with jqXHR
  remove(id, success, error) {
    if (!this.client) {
      throw new Error("Client required to remove");
    }

    const params = { client: this.client };
    return this.httpClient("DELETE", this.url + "/" + id, params, null, success, function(err) {
      // 410 is an acceptable delete status
      if (err.status === 410) {
        return success();
      } else {
        return error(err);
      }
    });
  }
}
