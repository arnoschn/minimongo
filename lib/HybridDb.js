/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
/*

Database which caches locally in a localDb but pulls results
ultimately from a RemoteDb

*/

let HybridDb;
const _ = require('lodash');
const { processFind } = require('./utils');
const utils = require('./utils');

// Bridges a local and remote database, querying from the local first and then 
// getting the remote. Also uploads changes from local to remote.
module.exports = (HybridDb = class HybridDb {
  constructor(localDb, remoteDb) {
    this.localDb = localDb;
    this.remoteDb = remoteDb;
    this.collections = {};
  }

  addCollection(name, options, success, error) {
    // Shift options over if not present
    if (_.isFunction(options)) {
      [options, success, error] = Array.from([{}, options, success]);
    }

    const collection = new HybridCollection(name, this.localDb[name], this.remoteDb[name], options);
    this[name] = collection;
    this.collections[name] = collection;
    if (success != null) { return success(); }
  }

  removeCollection(name, success, error) {
    delete this[name];
    delete this.collections[name];
    if (success != null) { return success(); }
  }

  upload(success, error) {
    const cols = _.values(this.collections);

    var uploadCols = function(cols, success, error) {
      const col = _.first(cols);
      if (col) {
        return col.upload(() => uploadCols(_.rest(cols), success, error)
        , err => error(err));
      } else {
        return success();
      }
    };
    return uploadCols(cols, success, error);
  }

  getCollectionNames() { return _.keys(this.collections); }
});

class HybridCollection {
  // Options includes
  constructor(name, localCol, remoteCol, options) {
    this.name = name;
    this.localCol = localCol;
    this.remoteCol = remoteCol;

    // Default options
    this.options = options || {};
    _.defaults(this.options, {
      cacheFind: true,       // Cache find results in local db
      cacheFindOne: true,    // Cache findOne results in local db
      interim: true,         // Return interim results from local db while waiting for remote db. Return again if different
      useLocalOnRemoteError: true,  // Use local results if the remote find fails. Only applies if interim is false.
      shortcut: false,       // true to return `findOne` results if any matching result is found in the local database. Useful for documents that change rarely.
      timeout: 0,            // Set to ms to timeout in for remote calls
      sortUpserts: null     // Compare function to sort upserts sent to server
    });
  }

  find(selector, options) {
    if (options == null) { options = {}; }
    return{ fetch: (success, error) => {
      return this._findFetch(selector, options, success, error);
    }
  };
  }

  // Finds one row.
  findOne(selector, options, success, error) {
    if (options == null) { options = {}; }
    if (_.isFunction(options)) {
      [options, success, error] = Array.from([{}, options, success]);
    }

    // Merge options
    _.defaults(options, this.options);

    // Happens after initial find
    const step2 = localDoc => {
      const findOptions = _.cloneDeep(options);
      findOptions.interim = false;
      findOptions.cacheFind = options.cacheFindOne;
      if (selector._id) {
        findOptions.limit = 1;
      } else {
        // Without _id specified, interaction between local and remote changes is complex
        // For example, if the one result returned by remote is locally deleted, we have no fallback
        // So instead we do a find with no limit and then take the first result, which is very inefficient
        delete findOptions.limit;
      }

      return this.find(selector, findOptions).fetch(function(data) {
        // Return first entry or null
        if (data.length > 0) {
          // Check that different from existing
          if (!_.isEqual(localDoc, data[0])) {
            return success(data[0]);
          }
        } else {
          // If nothing found, always report it, as interim find doesn't return null
          return success(null);
        }
      }
      , error);
    };

    // If interim or shortcut, get local first
    if (options.interim || options.shortcut) {
      return this.localCol.findOne(selector, options, function(localDoc) {
        // If found, return
        if (localDoc) {
          success(_.cloneDeep(localDoc));

          // If shortcut, we're done
          if (options.shortcut) {
            return;
          }
        }
        return step2(localDoc);
      }
      , error);
    } else {
      return step2();
    }
  }

  _findFetch(selector, options, success, error) {
    // Merge options
    _.defaults(options, this.options);

    const step2 = localData => {
      // Setup remote options
      const remoteOptions = _.cloneDeep(options);

      // If caching, get all fields
      if (options.cacheFind) {
        delete remoteOptions.fields;
      }

      // Add localData to options for remote find for quickfind protocol
      remoteOptions.localData = localData;

      // Setup timer variables
      let timer = null;
      let timedOut = false;

      const remoteSuccess = remoteData => {
        // Cancel timer
        if (timer) {
          clearTimeout(timer);
        }

        // Ignore if timed out, caching asynchronously
        if (timedOut) {
          if (options.cacheFind) {
            this.localCol.cache(remoteData, selector, options, (function() {}), error);
          }
          return;
        }

        if (options.cacheFind) {
          // Cache locally
          const cacheSuccess = () => {
            // Get local data again
            const localSuccess2 = function(localData2) {
              // Check if different or not interim
              if (!options.interim || !_.isEqual(localData, localData2)) {
                // Send again
                return success(localData2);
              }
            };
            return this.localCol.find(selector, options).fetch(localSuccess2, error);
          };
          return this.localCol.cache(remoteData, selector, options, cacheSuccess, error);
        } else {
          // Remove local remotes
          let data = remoteData;

          return this.localCol.pendingRemoves(removes => {
            if (removes.length > 0) {
              const removesMap = _.object(_.map(removes, id => [id, id]));
              data = _.filter(remoteData, doc => !_.has(removesMap, doc._id));
            }

            // Add upserts
            return this.localCol.pendingUpserts(function(upserts) {
              if (upserts.length > 0) {
                // Remove upserts from data
                const upsertsMap = _.object(_.map(upserts, u => u.doc._id), _.map(upserts, u => u.doc._id));
                data = _.filter(data, doc => !_.has(upsertsMap, doc._id));

                // Add upserts
                data = data.concat(_.pluck(upserts, "doc"));

                // Refilter/sort/limit
                data = processFind(data, selector, options);
              }

              // Check if different or not interim
              if (!options.interim || !_.isEqual(localData, data)) {
                // Send again
                return success(data);
              }
            }
            , error);
          }
          , error);
        }
      };

      const remoteError = err => {
        // Cancel timer
        if (timer) {
          clearTimeout(timer);
        }

        if (timedOut) {
          return;
        }

        // If no interim, do local find
        if (!options.interim) {
          if (options.useLocalOnRemoteError) {
            return success(localData);
          } else {
            if (error) { return error(err); }
          }
        } else {
          // Otherwise do nothing
          return;
        }
      };

      // Start timer if remote
      if (options.timeout) {
        timer = setTimeout(() => {
          timer = null;
          timedOut = true;

          // If no interim, do local find
          if (!options.interim) {
            if (options.useLocalOnRemoteError) {
              return this.localCol.find(selector, options).fetch(success, error);
            } else {
              if (error) { return error(new Error("Remote timed out")); }
            }
          } else {
            // Otherwise do nothing
            return;
          }
        }
        , options.timeout);
      }

      return this.remoteCol.find(selector, remoteOptions).fetch(remoteSuccess, remoteError);
    };

    const localSuccess = function(localData) {
      // If interim, return data immediately
      if (options.interim) {
        success(localData);
      }
      return step2(localData);
    };

    // Always get local data first
    return this.localCol.find(selector, options).fetch(localSuccess, error);
  }

  upsert(docs, bases, success, error) {
    return this.localCol.upsert(docs, bases, function(result) {
      // Bases is optional 
      if (_.isFunction(bases)) {
        success = bases;
      }
        
      return (typeof success === 'function' ? success(docs) : undefined);
    }
    , error);
  }

  remove(id, success, error) {
    return this.localCol.remove(id, function() {
      if (success != null) { return success(); }
    }
    , error);
  }

  upload(success, error) {
    var uploadUpserts = (upserts, success, error) => {
      const upsert = _.first(upserts);
      if (upsert) {
        return this.remoteCol.upsert(upsert.doc, upsert.base, remoteDoc => {
          return this.localCol.resolveUpserts([upsert], () => {
            // Cache new value if present
            if (remoteDoc) {
              return this.localCol.cacheOne(remoteDoc, () => uploadUpserts(_.rest(upserts), success, error)
              , error);
            } else {
              // Remove local
              return this.localCol.remove(upsert.doc._id, () => {
                // Resolve remove
                return this.localCol.resolveRemove(upsert.doc._id, () => uploadUpserts(_.rest(upserts), success, error)
                , error);
              }
              , error);
            }
          }
          , error);
        }
        , err => {
          // If 410 error or 403, remove document
          if ((err.status === 410) || (err.status === 403)) {
            return this.localCol.remove(upsert.doc._id, () => {
              // Resolve remove
              return this.localCol.resolveRemove(upsert.doc._id, function() {
                // Continue if was 410
                if (err.status === 410) {
                  return uploadUpserts(_.rest(upserts), success, error);
                } else {
                  return error(err);
                }
              }
              , error);
            }
            , error);
          } else {
            return error(err);
          }
        });
      } else {
        return success();
      }
    };

    var uploadRemoves = (removes, success, error) => {
      const remove = _.first(removes);
      if (remove) {
        return this.remoteCol.remove(remove, () => {
          return this.localCol.resolveRemove(remove, () => uploadRemoves(_.rest(removes), success, error)
          , error);
        }
        , err => {
          // If 403 or 410, remove document
          if ((err.status === 410) || (err.status === 403)) {
            return this.localCol.resolveRemove(remove, function() {
              // Continue if was 410
              if (err.status === 410) {
                return uploadRemoves(_.rest(removes), success, error);
              } else {
                return error(err);
              }
            }
            , error);
          } else {
            return error(err);
          }
        }
        , error);
      } else {
        return success();
      }
    };

    // Get pending upserts
    return this.localCol.pendingUpserts(upserts => {
      // Sort upserts if sort defined
      if (this.options.sortUpserts) {
        upserts.sort(this.options.sortUpserts);
      }
        
      return uploadUpserts(upserts, () => {
        return this.localCol.pendingRemoves(removes => uploadRemoves(removes, success, error)
        , error);
      }
      , error);
    }
    , error);
  }
}
