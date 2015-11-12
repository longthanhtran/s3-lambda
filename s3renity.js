'use strict'

var aws = require('aws-sdk'),
  fs = require('fs');

const TYPE_S3 = 's3';
const TYPE_FILE = 'file';
var s3;

/**
 * Give access to batch operations over s3 files, as well as a promised base
 * wrapper around the s3 api.
 *
 * @author Wells Johnston <wells@littlstar.com>
 * @exports Nice
 */

module.exports = Nice;

/**
 * Nice access to files in S3.
 *
 * @class Nice
 * @constructor
 * @param {object} aws your aws credentials. this object contains two keys
 * access_key_id and secred_access_key
 */

function Nice(conf) {

  if (!(this instanceof Nice)) {
    return new Nice();
  }

  if (conf.key) {
    this.context(conf.key);
  }

  this.encoding = conf.encoding || 'utf8';

  aws.config.update({
    accessKeyId: conf.access_key_id,
    secretAccessKey: conf.secret_access_key
  });

  s3 = new aws.S3();
}

/**
 * Set the working context based on an s3 key.
 *
 * @public
 * @param {string} key a key in the form: "s3://<your-bucket>/path/to/folder/"
 * @returns {Nice} `this`
 */

Nice.prototype.context = function(key) {
  var target = resolveKey(key);
  if (target.type != TYPE_S3) {
    throw new Error(
      'Context needs to be a valid s3 path. Ex: "s3://<bucket>/path/to/folder/"'
    );
  }
  this.bucket = target.bucket;
  this.prefix = target.prefix;
  return this;
};

/**
 * Sets the working context encoding.
 *
 * @public
 * @param {string} encoding The type of encoding to use with S3 objects. Default is "utf8".
 * @return {Nice} `this`
 */

Nice.prototype.encode = function(encoding) {
  this.encoding = encoding;
  return this;
};

/**
 * Returns a promise that gets all the keys in the given context.
 *
 * @public
 * @return {promise} Fulfilled when all the keys are retrieved from s3.
 */

Nice.prototype.keys = function() {

  const _keys = (allKeys, marker, success, fail) => {
    this.list(this.bucket, this.prefix, marker).then(keys => {
      if (keys.length == 0) {
        success(allKeys);
        return;
      }
      keys.forEach(key => {
        allKeys.push(key.Key);
        marker = key.Key;
      });
      _keys(allKeys, marker, success, fail);
      return;
    }).catch(fail);
  };

  return new Promise((success, fail) => {
    _keys([], '', success, fail);
  });
};

/**
 * Move the context from s3 objects to objects split by a delimiter.
 *
 * @public
 * @param {string} delimiter The character to split the document objects by.
 * Default is "\n"
 * @return {Nice} `this`
 */

Nice.prototype.split = function(delimiter) {
  this.delimiter = delimiter || '\n';
  return this;
};

/**
 * Join the objects in the working context by the given delimiter and return the
 * result.
 *
 * @public
 * @param {string} delimiter The character used to join the documents by.
 * Default is "\n"
 * @return {promise} Returns the body and `this` on success.
 */

Nice.prototype.join = function(delimiter) {

  if (delimiter == null) delimiter = '\n';

  return new Promise((success, fail) => {
    this.keys().then(keys => {
      var getPromises = [];
      keys.forEach(key => {
        getPromises.push(this.get(this.bucket, key));
      });
      Promise.all(getPromises).then(objects => {
        success(objects.join(delimiter));
      }).catch(fail);
    }).catch(fail);
  });
};

/**
 * Returns a promise that performs a function on each object in
 * the working context. When all the functions are done, the promise is
 * fulfilled.
 *
 * @public
 * @param {function} func This function takes an s3 object and performs a
 * synchronous function. If isAsync is true, func returns a promise.
 * @param {boolean} isAsync Optional, default is false. If set to true, this
 * indicates that func returns a
 * promise that should be executed.
 * @return {promise} Fulfilled when the mapper functions are done. Returns a
 * list of keys that were operated over.
 */

Nice.prototype.forEach = function(func, isAsync) {

  if (typeof func != 'function') {
    throw new TypeError('func must be a function');
  }

  if (isAsync == null) {
    isAsync = false;
  }

  var updates;

  const _eachObject = (keys, callback) => {
    if (keys.length == 0) {
      callback(null);
      return;
    }
    const key = keys.shift();
    this.get(this.bucket, key).then(body => {
      if (isAsync) {
        func(body).then(_ => {
          _eachObject(keys, callback);
        }).catch(callback);
      } else {
        try {
          func(body);
        } catch (e) {
          callback(e);
          return;
        }
        _eachObject(keys, callback);
      }
    }).catch(callback);
  };

  const _splitObjects = (keys, callback) => {
    if (keys.length == 0) {
      callback(null);
      return;
    }
    const key = keys.shift();
    this.splitObject(this.bucket, key, this.delimiter, this.encoding)
      .then(entries => {
        _eachSplit(entries).then(_ => {
          _splitObjects(keys, callback);
        }).catch(callback);
      }).catch(callback);
  };

  const _eachSplit = entries => {
    return new Promise((success, fail) => {
      if (isAsync) {
        updates = [];
        entries.forEach(entry => {
          updates.push(func(entry));
        });
        Promise.all(updates).then(success).catch(fail);
      } else {
        try {
          entries.forEach(func);
          success();
        } catch (err) {
          fail(err);
        }
      }
    });
  };

  return new Promise((success, fail) => {
    this.keys().then(keys => {
      if (this.delimiter == null) {
        _eachObject(keys, err => {
          if (err) {
            fail(err);
          } else {
            success(keys);
          }
        });
      } else {
        _splitObjects(keys, err => {
          if (err) {
            fail(err);
          } else {
            success(keys);
          }
        })
      }
    }).catch(fail);
  });
};

/**
 * Warning: destructive. Maps a function over the objects in the working
 * context, replaceing each with the return value.
 *
 * @public
 * @param {function} func The function to map over each object in the working
 * context. Func takes the object as a parameter and returns the value that
 * should replace it.
 * @param {boolean} isAsync Optional, default is false. If set to true, this indicates that func returns a promise.
 * @return {promise} Fulfilled when map is complete.
 */

Nice.prototype.map = function(func, isAsync) {

  if (typeof func != 'function') {
    throw new TypeError('func must be a function');
  }

  if (isAsync == null) {
    isAsync = false;
  }

  var entryUpdates, result;

  const _mapObject = (keys, callback) => {
    if (keys.length == 0) {
      callback(null);
      return;
    }
    const key = keys.shift();
    this.get(this.bucket, key).then(body => {
      if (isAsync) {
        func(body).then(newBody => {
          this.put(this.bucket, key, newBody).then(_ => {
            _mapObject(keys, callback);
          }).catch(callback);
        }).catch(callback);
      } else {
        try {
          result = func(body);
        } catch (e) {
          callback(e);
          return;
        }
        this.put(this.bucket, key, result).then(_ => {
          _mapObject(keys, callback);
        }).catch(callback);
      }
    }).catch(callback);
  };

  const _splitObjects = (keys, callback) => {
    if (keys.length == 0) {
      callback(null);
      return;
    }
    const key = keys.shift();
    this.splitObject(this.bucket, key, this.delimiter, this.encoding).then(
      entries => {
        _mapSplit(entries).then(newEntries => {
          const newBody = newEntries.join(this.delimiter);
          this.put(this.bucket, key, newBody).then(_ => {
            _splitObjects(keys, callback);
          }).catch(callback);
        }).catch(callback);
      }).catch(callback);
  };

  const _mapSplit = entries => {
    return new Promise((success, fail) => {
      if (isAsync) {
        entryUpdates = [];
        entries.forEach(entry => {
          entryUpdates.push(func(entry));
        });
        Promise.all(entryUpdates).then(success).catch(fail);
      } else {
        try {
          success(entries.map(func));
        } catch (err) {
          fail(err);
        }
      }
    });
  };

  return new Promise((success, fail) => {
    this.keys().then(keys => {
      if (this.delimiter == null) {
        _mapObject(keys, err => {
          if (err) {
            fail(err);
          } else {
            success();
          }
        });
      } else {
        _splitObjects(keys, err => {
          if (err) {
            fail(err)
          } else {
            success();
          }
        });
      }
    }).catch(fail);
  });
};

/**
 * Reduce the objects in the working context to a single value.
 *
 * @param {function} func Function to execute on each value in the array, taking
 * four arguments:
 *   previousValue - The value previously returned in the last invocation of
 *   func
 *   currentValue  - The current entry being processed
 *   key           - The key of the current object being processed
 *   func either returns the updated value, or a promise that resolves to the
 *   updated value.
 * @param {string} initialValue Optional.  Value to use as the first argument to
 * the first call of func.
 * @param {boolean} isAsync Optional, defaults to false. If set to true, this
 * indicates that func returns a promise.
 * @return {promise} Returns the reduced result.
 */

Nice.prototype.reduce = function(func, initialValue, isAsync) {

  if (typeof func != 'function') {
    throw new TypeError('func must be a function');
  }

  if (isAsync == null) {
    isAsync = false;
  }

  var value = initialValue,
    key, entry;

  const _reduceObjects = (keys, callback) => {
    if (keys.length == 0) {
      callback(null, value);
      return;
    }
    key = keys.shift();
    this.get(this.bucket, key).then(body => {
      if (isAsync) {
        func(value, body, key).then(newValue => {
          value = newValue;
          _reduceObjects(keys, callback);
        }).catch(e => callback(e, null));
      } else {
        value = func(value, body, key);
        _reduceObjects(keys, callback);
      }
    }).catch(e => callback(e, null));
  };

  const _splitAndReduceObjects = (keys, callback) => {
    if (keys.length == 0) {
      callback(null, value);
    }
    key = keys.shift();
    this.splitObject(this.bucket, key, this.delimiter, this.encoding).then(
      entries => {
        _reduceSplitEntries(key, entries, _ => {
          _splitAndReduceObjects(keys, callback);
        });
      }).catch(e => callback(e, null));
  };

  const _reduceSplitEntries = (key, entries, done) => {
    if (entries.length == 0) {
      done();
      return;
    }
    entry = entries.shift();
    if (isAsync) {
      func(value, entry, key).then(newValue => {
        value = newValue;
        _reduceSplitEntries(key, entries, done);
      }).catch(e => {
        callback(e, null);
      });
    } else {
      try {
        value = func(value, entry, key);
        _reduceSplitEntries(key, entries, done);
      } catch (e) {
        callback(e, null);
      }
    }
  };

  return new Promise((success, fail) => {
    this.keys().then(keys => {
      if (this.delimiter == null) {
        _reduceObjects(keys, (err, result) => {
          if (err) {
            fail(err);
          } else {
            success(result);
          }
        });
      } else {
        _splitAndReduceObjects(keys, (err, result) => {
          if (err) {
            fail(err);
          } else {
            success(result);
          }
        });
      }
    }).catch(fail);
  });
};

/**
 * Filter the objects in the working context.
 *
 * @public
 * @param {function} func The function to filter objects by, returning true for
 * objects that should not be filtered and false for those that should. If
 * isAsync is set to true, func returns a promise that resolves to true or
 * false.
 * @param {boolean} isAsync Optional, defaults to false. If set to true, this
 * indicates that func returns a promise.
 */

Nice.prototype.filter = function(func, isAsync) {

  if (typeof func != 'function') {
    throw new TypeError('func must be a function');
  }

  if (isAsync == null) {
    isAsync = false;
  }

  var key, result, promises, newBody, newSplitEntries;

  // recursively get all objects and run filter function
  const _filterObjects = (keys, callback) => {
    if (keys.length == 0) {
      callback(null);
      return;
    }
    key = keys.shift();
    this.get(this.bucket, key).then(body => {
      if (isAsync) {
        func(body).then(result => {
          if (result) {
            _filterObjects(keys, callback);
            return;
          }
          this.delete(this.bucket, key).then(_ => {
            _filterObjects(keys, callback);
          }).catch(callback);
        }).catch(callback);
      } else {
        try {
          result = func(body);
        } catch (e) {
          callback(e);
          return;
        }
        if (result) {
          _filterObjects(keys, callback);
          return;
        }
        this.delete(this.bucket, key).then(_ => {
          _filterObjects(keys, callback);
        }).catch(callback);
      }
    }).catch(callback);
  };

  const _splitObjects = (keys, callback) => {
    if (keys.length == 0) {
      callback(null);
      return;
    }
    key = keys.shift();
    this.splitObject(this.bucket, key, this.delimiter, this.encoding)
      .then(entries => {
        _filterSplitObject(entries).then(newEntries => {
          newBody = newEntries.join(this.delimiter);
          this.put(this.bucket, key, newBody).then(_ => {
            _splitObjects(keys, callback);
          }).catch(callback);
        }).catch(callback);
      }).catch(callback);
  };

  // runs the filter function on a split (containing entries)
  const _filterSplitObject = entries => new Promise((success, fail) => {
    if (isAsync) {
      promises = [];
      entries.forEach(entry => {
        promises.push(func(entry));
      });
      Promise.all(promises).then(results => {
        newSplitEntries = [];
        results.forEach((pass, i) => {
          if (pass) {
            newSplitEntries.push(entries[i]);
          }
          success(newSplitEntries);
        });
      }).catch(fail);
    } else {
      try {
        success(entries.filter(func));
      } catch (err) {
        fail(err);
      }
    }
  });

  return new Promise((success, fail) => {
    this.keys().then(keys => {
      if (this.delimiter == null) {
        _filterObjects(keys, err => {
          if (err) {
            fail(err);
          } else {
            success();
          }
        });
      } else {
        _splitObjects(keys, err => {
          if (err) {
            fail(err);
          } else {
            success();
          }
        });
      }
    }).catch(fail);
  });
};

/**
 * Removes empty objects in the working context.
 *
 * @public
 * @return {promise} Purges empty files.
 */

Nice.prototype.clean = function() {
  return this.filter(body => body.length > 0);
};

/**
 * Output the working context to a file or location in s3.
 *
 * @public
 * @param {string} target The location to write to.  Can be a local file,
 * s3 path like: s3://<bucket>/path/to/file, or an array of paths.
 * @return {promise} Fulfilled when the file is finished saving. Returns the
 * response either from `fs` or s3.
 */

Nice.prototype.write = function(body, targets) {
  return new Promise((success, fail) => {
    if (typeof targets == 'string') {
      targets = [targets];
    }
    var outputPromises = [];
    targets.forEach(target => {
      target = resolveKey(target);
      outputPromises.push(new Promise((_success, _fail) => {
        if (target.type == TYPE_S3) {
          this
            .put(target.bucket, target.prefix, body)
            .then(_success).catch(_fail);
        } else if (target.type == TYPE_FILE) {
          fs.writeFile(target.file, body, (err, res) => {
            if (err) {
              _fail(err);
            } else {
              _success();
            }
          });
        }
      }));
    });
    Promise.all(outputPromises).then(success).catch(fail);
  });
};

/**
 * Splits an object in s3 by a delimiter and returns.
 *
 * @param {string} bucket The s3 bucket to use.
 * @param {string} key The key to the object.
 * @param {string} delimiter Optional, default is \n. The character to use in
 * the split over the object's body.
 * @param {string} encoding Optional, default is utf8.
 * @return {promise} Returns an array that is the split of the object.
 */

Nice.prototype.splitObject = function(bucket, key, delimiter, encoding) {
  return new Promise((success, fail) => {
    if (delimiter == null) delimiter = '\n';
    if (encoding == null) encoding = 'utf8';
    this.get(bucket, key).then(body => {
      try {
        success(body.split(delimiter));
      } catch (err) {
        fail(err);
      }
    }).catch(fail);
  });
};

/**
 * Returns a promise that gets an object from s3.
 *
 * @public
 * @param {string} arg1 Can either be a valid s3 path or a bucket.
 * @param {string} arg2 Optional. If arg1 is a bucket, arg2 is the key.
 * @return {promise} Fulfilled when object is retrieved.
 */

Nice.prototype.get = function(arg1, arg2) {
  var target = resolveKey(arg1),
    bucket, key;
  if (target.type == TYPE_S3) {
    bucket = target.bucket;
    key = target.prefix;
  } else {
    bucket = arg1;
    key = arg2;
  }
  return new Promise((success, fail) => {
    s3.getObject({
      Bucket: bucket,
      Key: key
    }, (err, object) => {
      if (err) {
        fail(err);
      } else {
        try {
          success(object.Body.toString(this.encoding));
        } catch (e) {
          fail(e);
        }
      }
    });
  });
};

/**
 * Returns a promise that puts an object in s3.
 *
 * @public
 * @param {string} bucket The s3 bucket to use.
 * @param {string} key The key path where the object will be placed.
 * @param {string} body The object body.
 * @return {promise} Fulfilled when the object is written to s3. Returns
 * response from s3.
 */

Nice.prototype.put = function(bucket, key, body) {
  return new Promise((success, fail) => {
    s3.putObject({
      Bucket: bucket,
      Key: key,
      Body: body
    }, (err, res) => {
      if (err) {
        fail(err);
      } else {
        success(res);
      }
    });
  });
};

/**
 * Returns a promise that deletes an object in S3.
 *
 * @public
 * @param {string} bucket The s3 bucket to use.
 * @param {string|array} keys The key of the object to delete, or an array of
 * keys.
 * @return {promise} Fulfilled when the object deleted. Returns `this`.
 */

Nice.prototype.delete = (bucket, key) => {
  if (typeof key == 'object') {
    return deleteObjects(bucket, key);
  }
  return new Promise((success, fail) => {
    s3.deleteObject({
      Bucket: bucket,
      Key: key
    }, (err, res) => {
      if (err) {
        fail(err);
      } else {
        success(res);
      }
    });
  });
};

/**
 * Return a promise that gets keys from s3 given a bucket, prefix and marker.
 *
 * @public
 * @param {string} bucket The bucket to get the keys from.
 * @param {string} prefix The prefix for the folder where the keys are.
 * @param {string} [marker] The marker to start from (optional).
 * @return {promise} Fulfilled when the keys are retrieved from s3.
 */

Nice.prototype.list = (bucket, prefix, marker) => new Promise(
  (success, fail) => {
    if (prefix[prefix.length - 1] != '/') prefix += '/';
    s3.listObjects({
      Bucket: bucket,
      Prefix: prefix,
      Marker: marker
    }, (err, keys) => {
      if (err) {
        fail(err);
      } else {
        keys = keys.Contents;
        if (keys.length && keys[0] == prefix) {
          delete keys[0];
        }
        success(keys);
      }
    });
  }
);

/**
 * Deletes a list of objects in S3.
 *
 * @public
 * @param {string} bucket The s3 bucket to use.
 * @param {array} keys The keys of the objects to delete.
 * @return {promise} Fulfilled when objects are deleted. Returns response.
 */

const deleteObjects = (bucket, keys) => new Promise((success, fail) => {
  keys.map((key, i, arr) => {
    arr[i] = {
      Key: key
    };
  });
  s3.deleteObjects({
    Bucket: bucket,
    Delete: {
      Objects: keys
    }
  }, (err, res) => {
    if (err) {
      fail(err);
    } else {
      success(res);
    }
  });
});

/**
 * Take a path or s3 key and resolve it.
 *
 * @public
 * @param {string} key an s3 key or local file path
 * @return {object} An object wity keys: bucket, prefix, file, and type.
 */

const resolveKey = key => {
  var target = {};
  if (key.indexOf('s3://') == 0) {
    key = key.substr(5, key.length - 1);
    target.bucket = key.split('/')[0];
    target.prefix = key.substr(key.indexOf('/') + 1, key.length);
    target.file = null;
    target.type = TYPE_S3;
  } else {
    target.bucket = null;
    target.prefix = null;
    target.file = key;
    target.type = TYPE_FILE;
  }
  return target;
};
