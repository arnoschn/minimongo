/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
let ReplicatingDb;
const _ = require('lodash');
const utils = require('./utils');
const { compileSort } = require('./selector');

// Replicates data into a both a master and a replica db. Assumes both are identical at start
// and then only uses master for finds and does all changes to both
// Warning: removing a collection removes it from the underlying master and replica!
module.exports = (ReplicatingDb = class ReplicatingDb {
  constructor(masterDb, replicaDb) {
    this.collections = {};

    this.masterDb = masterDb;
    this.replicaDb = replicaDb;
  }

  addCollection(name, success, error) {
    const collection = new Collection(name, this.masterDb[name], this.replicaDb[name]);
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

// Replicated collection.
class Collection {
  constructor(name, masterCol, replicaCol) {
    this.name = name;
    this.masterCol = masterCol;
    this.replicaCol = replicaCol;
  }

  find(selector, options) {
    return this.masterCol.find(selector, options);
  }

  findOne(selector, options, success, error) {
    return this.masterCol.findOne(selector, options, success, error);
  }

  upsert(docs, bases, success, error) {
    let items;
    [items, success, error] = Array.from(utils.regularizeUpsert(docs, bases, success, error));

    // Upsert does to both
    return this.masterCol.upsert(_.pluck(items, "doc"), _.pluck(items, "base"), () => {
      return this.replicaCol.upsert(_.pluck(items, "doc"), _.pluck(items, "base"), results => {
        return success(docs);
      }
      , error);
    }
    , error);
  }

  remove(id, success, error) {
    // Do to both
    return this.masterCol.remove(id, () => {
      return this.replicaCol.remove(id, success, error);
    }
    , error);
  }

  cache(docs, selector, options, success, error) {
    // Calculate what has to be done for cache using the master database which is faster (usually MemoryDb)
    // then do minimum to both databases

    // Index docs
    let sort;
    const docsMap = _.indexBy(docs, "_id");

    // Compile sort
    if (options.sort) {
      sort = compileSort(options.sort);
    }

    // Perform query
    return this.masterCol.find(selector, options).fetch(results => {
      let result;
      const resultsMap = _.indexBy(results, "_id");

      // Determine if each result needs to be cached
      const toCache = [];
      for (let doc of Array.from(docs)) {
        result = resultsMap[doc._id];

        // If not present locally, cache it
        if (!result) {
          toCache.push(doc);
          continue;
        }

        // If both have revisions (_rev) and new one is same or lower, do not cache
        if (doc._rev && result._rev && (doc._rev <= result._rev)) {
          continue;
        }

        // Only cache if different
        if (!_.isEqual(doc, result)) {
          toCache.push(doc);
        }
      }

      const toUncache = [];
      for (result of Array.from(results)) {
        // If at limit
        if (options.limit && (docs.length === options.limit)) {
          // If past end on sorted limited, ignore
          if (options.sort && (sort(result, _.last(docs)) >= 0)) {
            continue;
          }
          // If no sort, ignore
          if (!options.sort) {
            continue;
          }
        }

        // Determine which ones to uncache
        if (!docsMap[result._id]) { 
          toUncache.push(result._id);
        }
      }

      // Cache ones needing caching
      const performCaches = next => {
        if (toCache.length > 0) {
          return this.masterCol.cacheList(toCache, () => {
            return this.replicaCol.cacheList(toCache, () => {
              return next();
            }
            , error);
          }
          , error);
        } else {
          return next();
        }
      };

      // Uncache list
      const performUncaches = next => {
        if (toUncache.length > 0) {
          return this.masterCol.uncacheList(toUncache, () => {
            return this.replicaCol.uncacheList(toUncache, () => {
              return next();
            }
            , error);
          }
          , error);
        } else {
          return next();
        }
      };

      return performCaches(() => {
        return performUncaches(() => {
          if (success != null) { success(); }
        });
      });
    }
    , error);
  }

  pendingUpserts(success, error) {
    return this.masterCol.pendingUpserts(success, error);
  }

  pendingRemoves(success, error) {
    return this.masterCol.pendingRemoves(success, error);
  }

  resolveUpserts(upserts, success, error) {
    return this.masterCol.resolveUpserts(upserts, () => {
      return this.replicaCol.resolveUpserts(upserts, success, error);
    }
    , error);
  }

  resolveRemove(id, success, error) {
    return this.masterCol.resolveRemove(id, () => {
      return this.replicaCol.resolveRemove(id, success, error);
    }
    , error);
  }

  // Add but do not overwrite or record as upsert
  seed(docs, success, error) {
    return this.masterCol.seed(docs, () => {
      return this.replicaCol.seed(docs, success, error);
    }
    , error);
  }

  // Add but do not overwrite upserts or removes
  cacheOne(doc, success, error) {
    return this.masterCol.cacheOne(doc, () => {
      return this.replicaCol.cacheOne(doc, success, error);
    }
    , error);
  }

  // Add but do not overwrite upserts or removes
  cacheList(docs, success, error) {
    return this.masterCol.cacheList(docs, () => {
      return this.replicaCol.cacheList(docs, success, error);
    }
    , error);
  }

  uncache(selector, success, error) {
    return this.masterCol.uncache(selector, () => {
      return this.replicaCol.uncache(selector, success, error);
    }
    , error);
  }

  uncacheList(ids, success, error) {
    return this.masterCol.uncacheList(ids, () => {
      return this.replicaCol.uncacheList(ids, success, error);
    }
    , error);
  }
}
