/*
* Copyright (c) 2015 Elio Cro <elio@front.no>
*
* Based on original code by:
* Copyright (c) 2011 Vinay Pulim <vinay@milewise.com>
*
* MIT Licensed
*/

var q = require('q');
var request = require('request');
var ws = require('ws.js');
var debug = require('debug')('soap-x509-http');


function X509HttpClient(options, credentials) {
  this._options = options || {};
  this._credentials = credentials;
}


/*
*   Build the request options object
*/
X509HttpClient.prototype.buildRequest = function(url, data, exheaders, exoptions) {
  var headers = {
    'User-Agent': 'X509HttpClient/0.1 (node-soap)',
    'Accept': 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'none',
    'Accept-Charset': 'utf-8',
    'Connection': 'close'
  };
  var attr;

  if (typeof data === 'string') {
    headers['Content-Length'] = Buffer.byteLength(data, 'utf8');
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  exheaders = exheaders || {};
  for (attr in exheaders) {
    headers[attr] = exheaders[attr];
  }

  var options = {
    method: data ? 'POST' : 'GET',
    url: url,
    headers: headers,
    followAllRedirects: true,
    body: data
  };

  // Attach authentication options
  for(attr in this._options) {
    options[attr] = this._options[attr];
  }

  exoptions = exoptions || {};
  for (attr in exoptions) {
    options[attr] = exoptions[attr];
  }

  debug('Http request: %j', options);
  return options;
};


/*
*   Cleanup the http response
*/
X509HttpClient.prototype.handleResponse = function(req, res, body) {
  debug('Http response body: %j', body);

  if (typeof body === 'string') {
    // Remove any extra characters that appear before or after the SOAP envelope.
    var match = body.match(/(?:<\?[^?]*\?>[\s]*)?<([^:]*):Envelope([\S\s]*)<\/\1:Envelope>/i);
    if (match) {
      body = match[0];
    }
  }
  return body;
};


/*
*   Replaces the default soap namespace with the 1.2 version.
*   This is required until node-soap's #627 pull request is accepted.
*/
X509HttpClient.prototype.fixSOAP12ns = function (data) {
  if(typeof data === 'string') {
    return data.replace(
      'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      'xmlns:soap="http://www.w3.org/2003/05/soap-envelope"');
  }
};


/*
*   Replaces the content-type header with the soap 1.2 version.
*   This is required until node-soap's #627 pull request is accepted.
*/
X509HttpClient.prototype.fixSOAP12header = function (options) {
  options.headers['Content-Type'] = 'application/soap+xml; charset=utf-8';
};


/*
*   Sign the xml with the client key
*/
X509HttpClient.prototype.signXML = function (data, url, action) {
  var d = q.defer();

  var x509 = new ws.X509BinarySecurityToken({
    'key': this._credentials.key.toString()
  });

  var signature = new ws.Signature(x509);
  signature.addReference('//*[local-name(.)=\'Body\']');
  signature.addReference('//*[local-name(.)=\'Timestamp\']');

  var security = new ws.Security({}, [ x509, signature ]);
  var addressing = new ws.Addr('http://www.w3.org/2005/08/addressing');

  var handler = {
    send: function (ctx, callback) {
      callback(ctx);
    }
  };
  var queue =  [ addressing, security, handler ];

  var ctx = {
    request: data,
    url: url,
    action: action
  };

  ws.send(queue, ctx, function (res) {
    debug('Signed xml: %j', res.request);
    d.resolve(res);
  });

  return d.promise;
};



X509HttpClient.prototype.request = function(url, data, callback, exheaders, exoptions) {
  debug('Source xml: %j', data);

  var self = this;
  var xml = self.fixSOAP12ns(data);
  var action = exheaders.SOAPAction && exheaders.SOAPAction.replace(/"/g, '') || '';

  // Sign xml
  self.signXML(xml, url, action)
  .then(function (signed) {

    // Build request and fix header
    var options = self.buildRequest(url, signed.request, exheaders, exoptions);
    self.fixSOAP12header(options);

    // Make the request
    var req = request(options, function (err, res, body) {
      if (err) {
        return callback(err);
      }

      body = self.handleResponse(req, res, body);
      callback(null, res, body);
    });
  },
  function (err) {
    callback(err);
  });
};


module.exports = X509HttpClient;
