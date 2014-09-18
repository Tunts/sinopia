var crypto = require('crypto')
  , Error = require('http-errors')
  , utils = require('./utils')
  , Logger = require('./logger')

module.exports.validate_name = function validate_name(req, res, next, value, name) {
	if (value.charAt(0) === '-') {
		// special case in couchdb usually
		next('route')
	} else if (utils.validate_name(value)) {
		next()
	} else {
		next(Error[403]('invalid ' + name))
	}
}

module.exports.media = function media(expect) {
	return function(req, res, next) {
		if (req.headers['content-type'] !== expect) {
			next(Error[415]('wrong content-type, expect: ' + expect
			              + ', got: '+req.headers['content-type']))
		} else {
			next()
		}
	}
}

module.exports.expect_json = function expect_json(req, res, next) {
	if (!utils.is_object(req.body)) {
		return next({
			status: 400,
			message: 'can\'t parse incoming json',
		})
	}
	next()
}

module.exports.anti_loop = function(config) {
	return function(req, res, next) {
		if (req.headers.via != null) {
			var arr = req.headers.via.split(',')
			for (var i=0; i<arr.length; i++) {
				var m = arr[i].match(/\s*(\S+)\s+(\S+)/)
				if (m && m[2] === config.server_id) {
					return next(Error[508]('loop detected'))
				}
			}
		}
		next()
	}
}

// express doesn't do etags with requests <= 1024b
// we use md5 here, it works well on 1k+ bytes, but sucks with fewer data
// could improve performance using crc32 after benchmarks
function md5sum(data) {
	return crypto.createHash('md5').update(data).digest('hex')
}

module.exports.log_and_etagify = function(req, res, next) {
	// logger
	req.log = Logger.logger.child({sub: 'in'})

	var _auth = req.headers.authorization
	if (_auth) req.headers.authorization = '<Classified>'
	req.log.info({req: req, ip: req.ip}, '@{ip} requested \'@{req.method} @{req.url}\'')
	if (_auth) req.headers.authorization = _auth

	var bytesin = 0
	req.on('data', function(chunk) {
		bytesin += chunk.length
	})

	var _send = res.send
	res.send = function(body) {
		try {
			if (typeof(body) === 'string' || typeof(body) === 'object') {
				if (!res.getHeader('Content-type')) {
					res.header('Content-type', 'application/json')
				}

				if (typeof(body) === 'object' && body != null) {
					if (typeof(body.error) === 'string') {
						res._sinopia_error = body.error
					}
					body = JSON.stringify(body, undefined, '\t') + '\n'
				}

				// don't send etags with errors
				if (!res.statusCode || (res.statusCode >= 200 && res.statusCode < 300)) {
					res.header('ETag', '"' + md5sum(body) + '"')
				}
			} else {
				// send(null), send(204), etc.
			}
		} catch(err) {
			// if sinopia sends headers first, and then calls res.send()
			// as an error handler, we can't report error properly,
			// and should just close socket
			if (err.message.match(/set headers after they are sent/)) {
				if (res.socket != null) res.socket.destroy()
				return
			} else {
				throw err
			}
		}

		res.send = _send
		res.send(body)
	}

	var bytesout = 0
	  , _write = res.write
	res.write = function(buf) {
		bytesout += buf.length
		_write.apply(res, arguments)
	}

	function log() {
		var message = '@{status}, user: @{user}, req: \'@{request.method} @{request.url}\''
		if (res._sinopia_error) {
			message += ', error: @{!error}'
		} else {
			message += ', bytes: @{bytes.in}/@{bytes.out}'
		}
		req.log.warn({
			request: {method: req.method, url: req.url},
			level: 35, // http
			user: req.remote_user.name,
			status: res.statusCode,
			error: res._sinopia_error,
			bytes: {
				in: bytesin,
				out: bytesout,
			}
		}, message)
	}

	req.on('close', function() {
		log(true)
	})

	var _end = res.end
	res.end = function(buf) {
		if (buf) bytesout += buf.length
		_end.apply(res, arguments)
		log()
	}
	next()
}

