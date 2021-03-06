var Q, dot, mongoose;

mongoose = require('mongoose');

dot = require('dot-component');

Q = require('q');

module.exports = {
  plugin: function(schema, options) {
    schema.virtual('_related').get(function() {
      return this.$__.related;
    }).set(function(val) {
      return this.$__.related = val;
    });
    schema.set('toObject', {
      virtuals: true
    });
    schema.set('toJSON', {
      virtuals: true
    });
    schema.post('init', function(next) {
      var info, orig, path, val, _ref;
      if (this.$__.populated != null) {
        this._related = {};
        _ref = this.$__.populated;
        for (path in _ref) {
          info = _ref[path];
          val = info.value;
          orig = dot.get(this, path);
          dot.set(this, path, val);
          dot.set(this._related, path, orig);
        }
      }
      return true;
    });
    schema.methods.cascadeSave = function() {
      this.$__.cascadeSave = true;
      return this.save.apply(this, arguments);
    };
    schema.methods.$__saveRelation = function(path, val) {
      var deferred, key, newVal, promises;
      deferred = Q.defer();
      promises = [];
      if (this.schema.paths[path]) {
        if (this.schema.paths[path].instance === 'ObjectID' && (this.schema.paths[path].options.ref != null)) {
          promises.push(this.$__saveSingleRelationAtPath(path));
        } else if (this.schema.paths[path].options.type instanceof Array && this.schema.paths[path].caster && this.schema.paths[path].caster.instance === 'ObjectID' && (this.schema.paths[path].caster.options.ref != null)) {
          promises.push(this.$__saveMultiRelationAtPath(path));
        }
      } else if (typeof val === 'object') {
        for (key in val) {
          newVal = val[key];
          promises.push(this.$__saveRelation(path + '.' + key, newVal));
        }
      }
      if (!promises.length) {
        deferred.resolve();
      } else {
        Q.all(promises).then(function() {
          return deferred.resolve();
        }, function(err) {
          return deferred.reject(err);
        });
      }
      return deferred.promise;
    };
    schema.methods.$__saveSingleRelationAtPath = function(path) {
      var data, deferred, ref, through,
        _this = this;
      deferred = Q.defer();
      ref = this.schema.paths[path].options.ref;
      through = this.schema.paths[path].options.$through;
      data = dot.get(this.get('_related'), path);
      this.$__saveRelatedDoc(path, data, ref, through).then(function(res) {
        _this.$__.populateRelations[path] = res;
        _this.set(path, res._id);
        return deferred.resolve();
      }, function(err) {
        return deferred.reject(err);
      });
      return deferred.promise;
    };
    schema.methods.$__saveMultiRelationAtPath = function(path) {
      var data, deferred, doc, promises, ref, through, _i, _len,
        _this = this;
      deferred = Q.defer();
      ref = this.schema.paths[path].caster.options.ref;
      through = this.schema.paths[path].caster.options.through;
      data = dot.get(this.get('_related'), path);
      promises = [];
      if (!(data instanceof Array)) {
        deferred.reject(new Error("Data for multi relation must be an array!"));
      } else {
        for (_i = 0, _len = data.length; _i < _len; _i++) {
          doc = data[_i];
          promises.push(this.$__saveRelatedDoc(path, doc, ref, through));
        }
        Q.all(promises).then(function(results) {
          var result, _j, _len1;
          _this.$__.populateRelations[path] = {};
          for (_j = 0, _len1 = results.length; _j < _len1; _j++) {
            result = results[_j];
            _this.$__.populateRelations[path][result._id.toString()] = result;
          }
          return deferred.resolve();
        });
      }
      return deferred.promise;
    };
    schema.methods.$__saveRelatedDoc = function(path, data, ref, through) {
      var d, deferred, isArray, method, modelClass, newMod, orig,
        _this = this;
      deferred = Q.defer();
      if (through) {
        d = dot.get(data, through);
        if (d instanceof Array) {
          if (d.indexOf(this._id) < 0) {
            d.push(this._id);
            dot.set(data, through, d);
          }
        } else {
          dot.set(data, through, this._id);
        }
      }
      modelClass = mongoose.model(ref);
      orig = this.get(path);
      if (orig instanceof Array) {
        isArray = true;
      } else {
        isArray = false;
      }
      if (data._id) {
        if (isArray) {
          orig.push(data._id);
          this.set(path, orig);
        } else {
          this.set(path, data._id);
        }
        modelClass.findById(data._id, function(err, res) {
          var method;
          if (err) {
            return deferred.reject(err);
          } else if (!res) {
            return deferred.reject(new Error('Could not find ref {ref} with ID ', +data._id.toString()));
          }
          delete data._id;
          res.set(data);
          if ((res.cascadeSave != null) && typeof res.cascadeSave === 'function') {
            method = 'cascadeSave';
          } else {
            method = 'save';
          }
          return res[method](function(err, res) {
            if (err) {
              return deferred.reject(err);
            }
            return deferred.resolve(res);
          });
        });
      } else {
        newMod = new modelClass(data);
        if (isArray) {
          orig.push(newMod._id);
          this.set(path, orig);
        } else {
          this.set(path, newMod._id);
        }
        if ((newMod.cascadeSave != null) && typeof newMod.cascadeSave === 'function') {
          method = 'cascadeSave';
        } else {
          method = 'save';
        }
        newMod[method](function(err, res) {
          if (err) {
            return deferred.reject(err);
          }
          return deferred.resolve(res);
        });
      }
      return deferred.promise;
    };
    schema.pre('save', function(next) {
      var path, promises, val, _ref;
      if (this.$__.cascadeSave) {
        this.$__.populateRelations = {};
        if (this._related != null) {
          promises = [];
          _ref = this._related;
          for (path in _ref) {
            val = _ref[path];
            promises.push(this.$__saveRelation(path, val));
          }
          return Q.all(promises).then(function() {
            return next();
          }, function(err) {
            return next(err);
          });
        } else {
          return next();
        }
      } else {
        return next();
      }
    });
    schema.post('save', function(doc) {
      var curVal, id, newRelated, newVal, path, rels, _i, _len, _ref;
      if (this.$__.cascadeSave) {
        newRelated = {};
        _ref = doc.$__.populateRelations;
        for (path in _ref) {
          rels = _ref[path];
          curVal = this.get(path);
          if (curVal instanceof Array) {
            newVal = [];
            for (_i = 0, _len = curVal.length; _i < _len; _i++) {
              id = curVal[_i];
              if (rels[id.toString()] != null) {
                newVal.push(rels[id.toString()]);
              } else {
                newVal.push(id);
              }
            }
            dot.set(newRelated, path, newVal);
          } else {
            if (rels._id === curVal) {
              dot.set(newRelated, path, rels);
            } else {
              dot.set(newRelated, path, curVal);
            }
          }
        }
        this.set('_related', newRelated);
        this.$__.cascadeSave = false;
      }
      return true;
    });
    schema.methods.$__handleDeletion = function(path) {
      if (this.schema.paths[path].instance === 'ObjectID' && (this.schema.paths[path].options.ref != null)) {
        return this.$__handleDeletionAtSingleRelationPath(path);
      } else if (this.schema.paths[path].options.type instanceof Array && this.schema.paths[path].caster && this.schema.paths[path].caster.instance === 'ObjectID' && (this.schema.paths[path].caster.options.ref != null)) {
        return this.$__handleDeletionAtMultiRelationPath(path);
      }
    };
    schema.methods.$__handleDeletionAtSingleRelationPath = function(path) {
      var cascade, ref, through;
      ref = this.schema.paths[path].options.ref;
      cascade = this.schema.paths[path].options.$cascadeDelete;
      through = this.schema.paths[path].options.$through;
      return this.$__handleDeletionOfDoc(ref, this.get(path), cascade, through);
    };
    schema.methods.$__handleDeletionAtMultiRelationPath = function(path) {
      var cascade, data, id, ref, through, _i, _len, _results;
      ref = this.schema.paths[path].caster.options.ref;
      cascade = this.schema.paths[path].caster.options.$cascadeDelete;
      through = this.schema.paths[path].caster.options.$through;
      data = this.get(path);
      _results = [];
      for (_i = 0, _len = data.length; _i < _len; _i++) {
        id = data[_i];
        _results.push(this.$__handleDeletionOfDoc(ref, id, cascade, through));
      }
      return _results;
    };
    schema.methods.$__handleDeletionOfDoc = function(ref, id, cascade, through) {
      var modelClass;
      modelClass = mongoose.model(ref);
      if (cascade) {
        return modelClass.findById(id, function(err, res) {
          if (res) {
            return res.remove();
          }
        });
      } else if (through) {
        return modelClass.findById(id, function(err, res) {
          if (res) {
            res.set(through, null);
            return res.save();
          }
        });
      }
    };
    return schema.post('remove', function(doc) {
      var config, path, _ref, _results;
      _ref = this.schema.paths;
      _results = [];
      for (path in _ref) {
        config = _ref[path];
        _results.push(this.$__handleDeletion(path));
      }
      return _results;
    });
  }
};
