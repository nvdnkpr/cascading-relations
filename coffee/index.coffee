mongoose = require 'mongoose'
dot = require 'dot-component'
Q = require 'q'
module.exports = (schema, options) ->
	# schema.add
	# 	'_related':mongoose.Schema.Types.Mixed
	schema.virtual('_related').get ->
		return @$__.related
	.set (val) ->
		@$__.related = val

	schema.set 'toObject', 
		virtuals:true

	schema.set 'toJSON',
		virtuals:true


	# Move populated docs over to _related and keep the original IDs
	schema.post 'init', (next) ->
		if @$__.populated?
			@_related = {}
			for path,info of @$__.populated
				val = info.value
				orig = dot.get(@, path)
				dot.set(@, path, val)
				dot.set(@_related, path, orig)

		return true


	schema.methods.cascadeSave = ->
		@$__.cascadeSave = true
		return @save.apply(@, arguments)
	# Save relations and update refs
	schema.methods.$__saveRelation = (path, val) ->
		deferred = Q.defer()
		promises = []
		if @schema.paths[path]
			if @schema.paths[path].instance is 'ObjectID' and @schema.paths[path].options.ref?
				promises.push(@$__saveSingleRelationAtPath(path))
			else if @schema.paths[path].options.type instanceof Array and @schema.paths[path].caster and @schema.paths[path].caster.instance is 'ObjectID' and @schema.paths[path].caster.options.ref?
				promises.push(@$__saveMultiRelationAtPath(path))

		else if typeof val is 'object'
			for key,newVal of val
				promises.push(@$__saveRelation(path + '.' + key, newVal))

		if !promises.length
			deferred.resolve()
		else
			Q.all(promises).then ->
				deferred.resolve()
			, (err) ->
				deferred.reject(err)
		return deferred.promise

	schema.methods.$__saveSingleRelationAtPath = (path) ->
		deferred = Q.defer()
		# Get the ref
		ref = @schema.paths[path].options.ref
		through = @schema.paths[path].options.$through

		data = dot.get(@get('_related'), path)

		@$__saveRelatedDoc(path, data, ref, through).then (res) =>
			@$__.populateRelations[path] = res
			@set(path, res._id)
			deferred.resolve()
		, (err) ->
			deferred.reject(err)

		return deferred.promise

	schema.methods.$__saveMultiRelationAtPath = (path) ->
		deferred = Q.defer()
		# Get the ref
		ref = @schema.paths[path].caster.options.ref
		through = @schema.paths[path].caster.options.through


		data = dot.get(@get('_related'), path)

		promises = []
		# Data needs to be an array. If it's not we're fucked
		if !(data instanceof Array)
			deferred.reject(new Error("Data for multi relation must be an array!"))
		else
			for doc in data
				promises.push(@$__saveRelatedDoc(path, doc, ref, through))

			Q.all(promises).then (results) =>
				
				# Reorder according to the IDs
				@$__.populateRelations[path] = {}
				for result in results
					@$__.populateRelations[path][result._id.toString()] = result
				deferred.resolve()

		return deferred.promise



	schema.methods.$__saveRelatedDoc = (path, data, ref, through) ->
		deferred = Q.defer()
		# If there's a through, set it, since we already have the ID
		if through
			d = dot.get(data, through)
			if d instanceof Array
				if d.indexOf(@_id) < 0
					d.push(@_id)
					dot.set(data, through, d)
			else
				dot.set(data, through, @_id)
		modelClass = mongoose.model(ref)
		
		# If there's an ID, fetch the object and update it.
		# Should we use middleware here? Or just findByIdAndUpdate?
		orig = @get(path)
		if orig instanceof Array
			isArray = true
		else
			isArray = false
		if data._id
			if isArray
				orig.push(data._id)
				@set(path, orig)
			else
				@set(path, data._id)
			modelClass.findById data._id, (err, res) =>
				if err
					return deferred.reject(err)
				else if !res
					return deferred.reject(new Error('Could not find ref {ref} with ID ', + data._id.toString()))
				delete data._id
				res.set(data)

				# If it has a cascade save method, use it. Otherwise just use save
				if res.cascadeSave? and typeof res.cascadeSave is 'function'
					method = 'cascadeSave'
				else
					method = 'save'
				res[method] (err, res) =>
					if err
						return deferred.reject(err)

					deferred.resolve(res)
		else

			# We need to create a new one
			newMod = new modelClass(data)
			if isArray
				orig.push(newMod._id)
				@set(path, orig)
			else
				@set(path, newMod._id)
			if newMod.cascadeSave? and typeof newMod.cascadeSave is 'function'
				method = 'cascadeSave'
			else
				method = 'save'
			newMod[method] (err, res) =>
				if err
					return deferred.reject(err)
				
				deferred.resolve(res)

		# Set it to the updated value
		return deferred.promise
	schema.pre 'save', (next) ->
		if @$__.cascadeSave
			@$__.populateRelations = {}
			if @_related?
				promises = []
				for path,val of @_related
					promises.push(@$__saveRelation(path, val))
				Q.all(promises).then ->
					next()
				, (err) ->
					next(err)
			else
				next()
		else
			next()


	schema.post 'save', (doc) ->
		if @$__.cascadeSave
			# Update related with new related objects
			newRelated = {}

			for path,rels of doc.$__.populateRelations
				curVal = @get(path)
				if curVal instanceof Array
					newVal = []
					for id in curVal
						if rels[id.toString()]?
							newVal.push(rels[id.toString()])
						else
							newVal.push(id)
					dot.set(newRelated, path, newVal)
				else
					if rels._id is curVal
						dot.set(newRelated, path, rels)
					else
						dot.set(newRelated, path, curVal)
			@set('_related', newRelated)
			@$__.cascadeSave = false

		return true

	schema.methods.$__handleDeletion = (path) ->

		if @schema.paths[path].instance is 'ObjectID' and @schema.paths[path].options.ref?
			@$__handleDeletionAtSingleRelationPath(path)
		else if @schema.paths[path].options.type instanceof Array and @schema.paths[path].caster and @schema.paths[path].caster.instance is 'ObjectID' and @schema.paths[path].caster.options.ref?
			@$__handleDeletionAtMultiRelationPath(path)

	schema.methods.$__handleDeletionAtSingleRelationPath = (path) ->
		ref = @schema.paths[path].options.ref
		cascade = @schema.paths[path].options.$cascadeDelete
		through = @schema.paths[path].options.$through
		@$__handleDeletionOfDoc(ref, @get(path), cascade, through)

	schema.methods.$__handleDeletionAtMultiRelationPath = (path) ->
		ref = @schema.paths[path].caster.options.ref
		cascade = @schema.paths[path].caster.options.$cascadeDelete
		through = @schema.paths[path].caster.options.$through
		
		data = @get(path)
		for id in data
			@$__handleDeletionOfDoc(ref, id, cascade, through)

	schema.methods.$__handleDeletionOfDoc = (ref, id, cascade, through) ->
		modelClass = mongoose.model(ref)

		# If it's cascade, just delete that other one. It might cascade too. Who cares?
		if cascade
			modelClass.findById id, (err, res) ->
				if res
					res.remove()
		
		# Otherwise, we need to update its $through value to not reference this one anymore
		else if through
			modelClass.findById id, (err, res) ->
				if res
					res.set(through, null)
					res.save()




	schema.post 'remove', (doc) ->
		# Handle relations. Basically we need to remove a reference
		# to this document in any related documents, or do a cascade
		# delete if designated
		for path,config of @schema.paths
			@$__handleDeletion(path)
		

