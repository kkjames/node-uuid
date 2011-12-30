//     node-uuid/uuid.js
//
//     Copyright (c) 2010 Robert Kieffer
//     Dual licensed under the MIT and GPL licenses.
//     Documentation and details at https://github.com/broofa/node-uuid
(function() {
  var _global = this;

  // Random # generation is vital for avoiding uuid collisions, but there's no
  // silver bullet option since Math.random isn't guaranteed to be
  // "cryptographic quality".  Instead, we feature-detect based on API
  // availability.
  //
  // (Each RNG API is normalized here to return 128-bits (16 bytes) of random
  // data)
  var mathRNG, nodeRNG, whatwgRNG;

  // Math.random-based RNG.  All browsers, fast (~1M/sec), but not guaranteed
  // to be cryptographic quality.
  var _rndBytes = new Array(16);
  mathRNG = function() {
    var r, b = _rndBytes, i = 0;

    for (var i = 0, r; i < 16; i++) {
      if ((i & 0x03) == 0) r = Math.random() * 0x100000000;
      b[i] = r >>> ((i & 0x03) << 3) & 0xff;
    }

    return b;
  }

  // WHATWG crypto-based RNG (http://wiki.whatwg.org/wiki/Crypto).  Currently
  // only in WebKit browsers, moderately fast (~100K/sec), guaranteed
  // cryptographic quality
  if (_global.crypto && crypto.getRandomValues) {
    var _rnds = new Uint32Array(4);
    whatwgRNG = function() {
      crypto.getRandomValues(_rnds);

      for (var c = 0 ; c < 16; c++) {
        _rndBytes[c] = _rnds[c >> 2] >>> ((c & 0x03) * 8) & 0xff;
      }
      return _rndBytes;
    }
  }

  // Node.js crypto-based RNG
  // (http://nodejs.org/docs/v0.6.2/api/crypto.html#randomBytes).
  // node.js only, slow (~10K/sec), guaranteed cryptographic quality
  try {
    var _rb = require('crypto').randomBytes;
    nodeRNG = function() {
      return _rb(16);
    };
  } catch (e) {}

  // Pick the RNG to use, preferring quality over speed
  var _rng = nodeRNG || whatwgRNG || mathRNG;

  // Buffer class to use
  var BufferClass = typeof(Buffer) == 'function' ? Buffer : Array;

  // Maps for number <-> hex string conversion
  var _byteToHex = [];
  var _hexToByte = {};
  for (var i = 0; i < 256; i++) {
    _byteToHex[i] = (i + 0x100).toString(16).substr(1);
    _hexToByte[_byteToHex[i]] = i;
  }

  // **`parse()` - Parse a UUID into it's component bytes**
  function parse(s, buf, offset) {
    var i = (buf && offset) || 0, ii = 0;

    buf = buf || [];
    s.toLowerCase().replace(/[0-9a-f]{2}/g, function(byte) {
      if (ii < 16) { // Don't overflow!
        buf[i + ii++] = _hexToByte[byte];
      }
    });

    // Zero out remaining bytes if string was short
    while (ii < 16) {
      buf[i + ii++] = 0;
    }

    return buf;
  }

  // **`unparse()` - Convert UUID byte array (ala parse()) into a string**
  function unparse(buf, offset) {
    var i = offset || 0, bth = _byteToHex;
    return  bth[buf[i++]] + bth[buf[i++]] +
            bth[buf[i++]] + bth[buf[i++]] + '-' +
            bth[buf[i++]] + bth[buf[i++]] + '-' +
            bth[buf[i++]] + bth[buf[i++]] + '-' +
            bth[buf[i++]] + bth[buf[i++]] + '-' +
            bth[buf[i++]] + bth[buf[i++]] +
            bth[buf[i++]] + bth[buf[i++]] +
            bth[buf[i++]] + bth[buf[i++]];
  }

  // **`v1()` - Generate time-based UUID**
  //
  // Inspired by https://github.com/LiosK/UUID.js
  // and http://docs.python.org/library/uuid.html

  // Per 4.1.4 - Offset (in msecs) from JS time to UUID (gregorian) time
  var EPOCH_OFFSET = 12219292800000;

  // random #'s we need to init node and clockseq
  var _seedBytes = _rng();

  // Per 4.5, create and 48-bit node id, (47 random bits + multicast bit = 1)
  var _nodeId = [
    _seedBytes[0] | 0x01,
    _seedBytes[1], _seedBytes[2], _seedBytes[3], _seedBytes[4], _seedBytes[5]
  ];

  // Per 4.2.2, randomize (14 bit) clockseq
  var _clockSeq = (_seedBytes[6] << 8 | _seedBytes[7]) & 0x3fff;

  // Previous uuid creation time
  var _last = 0;

  // Count of UUIDs created during current time tick
  var _count = 0;

  // See https://github.com/broofa/node-uuid for API details
  function v1(options, buf, offset) {
    var i = buf && offset || 0;
    var b = buf || [];

    options = options || {};

    // JS Numbers aren't capable of representing time in the RFC-specified
    // 100-nanosecond units. To deal with this, we represent time as the usual
    // JS milliseconds, plus an additional 100-nanosecond unit offset.
    var msecs = 0; // JS time (msecs since Unix epoch)
    var nsecs = 0; // additional 100-nanosecond units to add to msecs

    if (options.msecs != null) {
      // Explicit time specified.  Not that this turns off the internal logic
      // around uuid count and clock sequence used insure uniqueness
      msecs = (+options.msecs) + EPOCH_OFFSET;
      nsecs = options.nsecs || 0;
    } else {
      // No time options - Follow the RFC logic (4.2.1.2) for maintaining
      // clock seq and uuid count to help insure UUID uniqueness.

      msecs = new Date().getTime() + EPOCH_OFFSET;

      if (msecs < _last) {
        // Clock regression - Per 4.2.1.2, increment clock seq
        _clockSeq++;
        _count = 0;
      } else {
        // Per 4.2.1.2, use a count of uuid's generated during the current
        // clock cycle to simulate higher resolution clock
        _count = (msecs == _last) ? _count + 1 : 0;
      }
      _last = msecs;

      // Per 4.2.1.2 If generator creates more than one id per uuid 100-ns
      // interval, throw an error
      // (Requires generating > 10M uuids/sec. While unlikely, it's not
      // entirely inconceivable given the benchmark results we're getting)
      if (_count >= 10000) {
        throw new Error('uuid.v1(): Can\'t create more than 10M uuids/sec');
      }

      nsecs = _count;
    }

    // Per 4.1.4, timestamp composition

    // `time_low`
    var tl = ((msecs & 0xfffffff) * 10000 + nsecs) % 0x100000000;
    b[i++] = tl >>> 24 & 0xff;
    b[i++] = tl >>> 16 & 0xff;
    b[i++] = tl >>> 8 & 0xff;
    b[i++] = tl & 0xff;

    // `time_mid`
    var tmh = (msecs / 0x100000000 * 10000) & 0xfffffff;
    b[i++] = tmh >>> 8 & 0xff;
    b[i++] = tmh & 0xff;

    // `time_high_and_version`
    b[i++] = tmh >>> 24 & 0xf | 0x10; // include version
    b[i++] = tmh >>> 16 & 0xff;

    // Clock sequence
    var cs = options.clockseq != null ? options.clockseq : _clockSeq;

    // `clock_seq_hi_and_reserved` (Per 4.2.2 - include variant)
    b[i++] = cs >>> 8 | 0x80;

    // `clock_seq_low`
    b[i++] = cs & 0xff;

    // node
    var node = options.node || _nodeId;
    for (var n = 0; n < 6; n++) {
      b[i + n] = node[n];
    }

    return buf ? buf : unparse(b);
  }

  // **`v4()` - Generate random UUID**

  // See https://github.com/broofa/node-uuid for API details
  function v4(options, buf, offset) {
    // Deprecated - 'format' argument, as supported in v1.2
    var i = buf && offset || 0;

    if (typeof(options) == 'string') {
      buf = options == 'binary' ? new BufferClass(16) : null;
      options = null;
    }
    options = options || {};

    var rnds = options.random || (options.rng || _rng)();

    // Per 4.4, set bits for version and `clock_seq_hi_and_reserved`
    rnds[6] = (rnds[6] & 0x0f) | 0x40;
    rnds[8] = (rnds[8] & 0x3f) | 0x80;

    // Copy bytes to buffer, if provided
    if (buf) {
      for (var ii = 0; ii < 16; ii++) {
        buf[i + ii] = rnds[ii];
      }
    }

    return buf || unparse(rnds);
  }

  // Export public API
  var uuid = v4;
  uuid.v1 = v1;
  uuid.v4 = v4;
  uuid.parse = parse;
  uuid.unparse = unparse;
  uuid.BufferClass = BufferClass;

  // Export RNG options
  uuid.mathRNG = mathRNG;
  uuid.nodeRNG = nodeRNG;
  uuid.whatwgRNG = whatwgRNG;

  if (typeof(module) != 'undefined') {
    // Play nice with node.js
    module.exports = uuid;
  } else {
    // Play nice with browsers
    var _previousRoot = _global.uuid;

    // **`noConflict()` - (browser only) to reset global 'uuid' var**
    uuid.noConflict = function() {
      _global.uuid = _previousRoot;
      return uuid;
    }
    _global.uuid = uuid;
  }
}());
