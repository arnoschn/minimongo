/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
const _ = require('lodash');
const sha1 = require(('js-sha1'));
const { compileSort } = require('./selector');

/*

Quickfind protocol allows sending information about which rows are already present locally to minimize 
network traffic.

Protocal has 3 phases:

encodeRequest: Done on client. Summarize which rows are already present locally by sharding and then hashing _id:_rev|
encodeResponse: Done on server. Given complete server list and results of encodeRequest, create list of changes, sharded by first two characters of _id
decodeResponse: Done on client. Given encoded response and local list, recreate complete list from server.

Interaction of sort, limit and fields:

- fields present: _rev might be missing. Do not use quickfind
- limit with no sort: This gives unstable results. Do not use quickfind
- sort: final rows need to be re-sorted. Since fields not present, is possible.
- no sort, no limit: always sort by _id

*/

// Characters to shard by of _id
const shardLength = 2;

// Given an array of client rows, create a summary of which rows are present
exports.encodeRequest = function(clientRows) {
  // Index by shard
  clientRows = _.groupBy(clientRows, row => row._id.substr(0, shardLength));

  // Hash each one
  const request = _.mapValues(clientRows, rows => hashRows(rows));

  return request;
};

// Given an array of rows on the server and an encoded request, create encoded response 
exports.encodeResponse = function(serverRows, encodedRequest) {
  // Index by shard
  serverRows = _.groupBy(serverRows, row => row._id.substr(0, shardLength));

  // Include any that are in encoded request but not present
  for (let key in encodedRequest) {
    const value = encodedRequest[key];
    if (!serverRows[key]) {
      serverRows[key] = [];
    }
  }

  // Only keep ones where different from encoded request
  const response = _.pick(serverRows, (rows, key) => hashRows(rows) !== encodedRequest[key]);

  return response;
};

// Given encoded response and array of client rows, create array of server rows
exports.decodeResponse = function(encodedResponse, clientRows, sort) {
  // Index by shard
  clientRows = _.groupBy(clientRows, row => row._id.substr(0, shardLength));

  // Overwrite with response
  let serverRows = _.extend(clientRows, encodedResponse);

  // Flatten
  serverRows = _.flatten(_.values(serverRows));

  // Sort
  if (sort) {
    serverRows.sort(compileSort(sort));
  } else {
    serverRows = _.sortBy(serverRows, "_id");
  }

  return serverRows;
};

var hashRows = function(rows) {
  const hash = sha1.create();
  for (let row of Array.from(_.sortBy(rows, "_id"))) {
    hash.update(row._id + ":" + (row._rev || "") + "|");
  }
  
  // 80 bits is enough for uniqueness
  return hash.hex().substr(0, 20);
};