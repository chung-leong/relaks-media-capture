var EventEmitter = require('relaks-event-emitter');
var GenericEvent = EventEmitter.GenericEvent;

var defaultOptions = {
    video: true,
    audio: true,
    preferredDevice: 'front',
    chooseNewDevice: true,
    captureImageOnly: false,
    watchVolume: false,
    deactivationDelay: 0,
    segmentDuration: undefined,
    videoMIMEType: 'video/webm',
    audioMIMEType: 'audio/webm',
    imageMIMEType: 'image/jpeg',
    audioBitsPerSecond: 128000,
    videoBitsPerSecond: 2500000,
};

function RelaksMediaCapture(options) {
    EventEmitter.call(this);
    this.options = {};
    this.status = undefined;
    this.liveVideo = undefined;
    this.liveAudio = undefined;
    this.lastError = null;
    this.devices = [];
    this.selectedDeviceID = undefined;

    this.stream = undefined;
    this.audioProcessor = undefined;
    this.audioContext = undefined;
    this.audioSource = undefined;
    this.mediaRecorder = null;
    this.mediaRecorderStartTime = null;
    this.mediaRecorderDuration = 0
    this.mediaRecorderInterval = 0;
    this.mediaRecorderBlobs = [];
    this.waitPromise = null;
    this.waitReject = null;
    this.waitResolve = null;
    this.waitTimeout = 0;

    this.handleDeviceChange = this.handleDeviceChange.bind(this);
    this.handleStreamEnd = this.handleStreamEnd.bind(this);
    this.handleAudioProcess = this.handleAudioProcess.bind(this);
    this.handleMediaRecorderData = this.handleMediaRecorderData.bind(this);
    this.handleMediaRecorderStart = this.handleMediaRecorderStart.bind(this);
    this.handleMediaRecorderStop = this.handleMediaRecorderStop.bind(this);
    this.handleMediaRecorderPause = this.handleMediaRecorderPause.bind(this);
    this.handleMediaRecorderResume = this.handleMediaRecorderResume.bind(this);
    this.handleMediaRecorderInterval = this.handleMediaRecorderInterval.bind(this);

    for (var name in defaultOptions) {
        if (options && options[name] !== undefined) {
            this.options[name] = options[name];
        } else {
            this.options[name] = defaultOptions[name];
        }
    }
}

var prototype = RelaksMediaCapture.prototype = Object.create(EventEmitter.prototype)

/**
 * Begin the capturing process, first by acquiring a recording device.
 * Capturing won't start until start() is called
 */
prototype.activate = function() {
    if (!this.active) {
        if (this.capturedVideo || this.capturedAudio || this.capturedImage) {
            // can't reactivate without calling clear() first
            return;
        }
        this.acquire();
        this.active = true;
        this.notifyChange();
        this.watchDevices();
    }
};

/**
 * End the capturing process, release the recording device and free
 * captured resources if extract() wasn't called
 */
prototype.deactivate = function() {
    if (this.active) {
        if (this.mediaRecorder) {
            clearInterval(this.mediaRecorderInterval);
            this.mediaRecorder.removeEventListener('dataavailable', this.handleMediaRecorderData);
            this.mediaRecorder.removeEventListener('start', this.handleMediaRecorderStart);
            this.mediaRecorder.removeEventListener('stop', this.handleMediaRecorderStop);
            this.mediaRecorder.removeEventListener('pause', this.handleMediaRecorderPause);
            this.mediaRecorder.removeEventListener('resume', this.handleMediaRecorderResume);
            this.mediaRecorder.stop();
            this.mediaRecorder = null;
            this.mediaRecorderStartTime = null;
            this.mediaRecorderDuration = 0
            this.mediaRecorderInterval = 0;
            this.mediaRecorderBlobs = [];
        }

        var _this = this;
        setTimeout(function() {
            _this.releaseInput();
            _this.revokeBlobs();
        }, this.options.deactivationDelay);
        this.unwatchDevices();
        this.active = false;
        this.notifyChange();
    }
};

/**
 * Acquire an input device
 *
 * @return {Promise}
 */
prototype.acquire = function() {
    var _this = this;
    if (!this.status) {
        this.status = 'acquiring';
    }
    var constraints = {
        video: this.options.video,
        audio: this.options.audio,
    };
    return getDevices(constraints).then(function(devices) {
        var preferred = _this.selectedDeviceID || _this.options.preferredDevice;
        var device = chooseDevice(devices, preferred);
        if (device) {
            var criteria = { deviceId: device.id };
            if (constraints.video) {
                constraints.video = criteria;
            } else if (constraints.audio) {
                constraints.audio = criteria;
            }
        }
        return getMediaStream(constraints).then(function(stream) {
            // stop all tracks
            _this.status = 'initiating';
            _this.devices = devices;
            _this.selectedDeviceID = (device) ? device.id : undefined;
            _this.notifyChange();

            if (constraints.video) {
                return getVideoStreamMeta(stream).then(function(meta) {
                    _this.stream = stream;
                    _this.liveVideo = {
                        stream: stream,
                        height: meta.height,
                        width: meta.width,
                    };
                    if (_this.options.watchVolume && constraints.audio) {
                        _this.watchAudioVolume();
                    }
                    _this.watchStreamStatus();
                    _this.status = 'previewing';
                    _this.notifyChange();
                });
            } else if (constraints.audio) {
                _this.stream = stream;
                _this.liveAudio = {
                    stream: stream,
                };
                if (_this.options.watchVolume) {
                    _this.watchAudioVolume();
                }
                _this.watchStreamStatus();
                _this.status = 'previewing';
                _this.notifyChange();
            }
        }).catch(function(err) {
            _this.lastError = err;
            _this.status = 'denied';
            _this.notifyChange();
            console.error(err);
            return null;
        });
    });
};

/**
 * Start capturing video/audio
 */
prototype.start = function() {
    if (!this.stream) {
        throw new RelaksMediaCaptureError('No media stream');
    }
    if (this.mediaRecorder) {
        return;
    }
    var segmentDuration = this.options.segmentDuration;
    var options = {};
    if (this.options.audio) {
        options.audioBitsPerSecond = this.options.audioBitsPerSecond;
        options.mimeType = this.options.audioMIMEType;
    }
    if (this.options.video) {
        options.videoBitsPerSecond = this.options.videoBitsPerSecond,
        options.mimeType = this.options.videoMIMEType;
    }
    this.mediaRecorder = new MediaRecorder(this.stream, options);
    this.mediaRecorder.addEventListener('dataavailable', this.handleMediaRecorderData);
    this.mediaRecorder.addEventListener('start', this.handleMediaRecorderStart);
    this.mediaRecorder.addEventListener('stop', this.handleMediaRecorderStop);
    this.mediaRecorder.addEventListener('pause', this.handleMediaRecorderPause);
    this.mediaRecorder.addEventListener('resume', this.handleMediaRecorderResume);
    this.mediaRecorder.start(segmentDuration);
};

/**
 * Stop capturing video/audio
 */
prototype.stop = function() {
    if (!this.mediaRecorder) {
        throw new RelaksMediaCaptureError('No media recorder');
    }
    this.mediaRecorder.stop();
};

/**
 * Pause recording
 */
prototype.pause = function() {
    if (!this.mediaRecorder) {
        throw new RelaksMediaCaptureError('No media recorder');
    }
    this.mediaRecorder.pause();
};

/**
 * Resume recording
 */
prototype.resume = function() {
    if (!this.mediaRecorder) {
        throw new RelaksMediaCaptureError('No media recorder');
    }
    this.mediaRecorder.resume();
};

/**
 * Capture a snapshot of the video input
 */
prototype.snap = function() {
    var _this = this;
    var mimeType = this.options.imageMIMEType;
    var quality = this.options.imageQuality || 90;
    var imageOnly = this.options.captureImageOnly;
    if (!this.liveVideo) {
        throw new RelaksMediaCaptureError('No video stream');
    }
    getVideoStreamSnapshot(this.stream).then(function(canvas) {
        saveCanvasContents(canvas, mimeType, quality).then(function(blob) {
            var url = URL.createObjectURL(blob);
            _this.capturedImage = {
                url: url,
                blob: blob,
                width: canvas.width,
                height: canvas.height,
            };
            if (imageOnly) {
                _this.status = 'captured';
            }
            _this.notifyChange();
        }).catch(function(err) {
            console.error(err);
        });
    });
};

/**
 * Keep an eye out for device addition/removal
 */
prototype.watchDevices = function() {
    var mediaDevices = navigator.mediaDevices;
    if (mediaDevices && mediaDevices.addEventListener) {
        mediaDevices.addEventListener('devicechange', this.handleDeviceChange);
    }
}

prototype.unwatchDevices = function() {
    var mediaDevices = navigator.mediaDevices;
    if (mediaDevices && mediaDevices.removeEventListener) {
        mediaDevices.removeEventListener('devicechange', this.handleDeviceChange);
    }
}

/**
 * Keep an eye on the input stream
 */
prototype.watchStreamStatus = function() {
    var tracks = this.stream.getTracks();
    for (var i = 0; i < tracks.length; i++) {
        tracks[i].onended = this.handleStreamEnd;
    }
};

prototype.unwatchStreamStatus = function () {
    var tracks = this.stream.getTracks();
    for (var i = 0; i < tracks.length; i++) {
        tracks[i].onended = null;
    }
};

/**
 * Keep an eye on the audio volume
 */
prototype.watchAudioVolume = function() {
    if (typeof(AudioContext) === 'function')  {
        this.audioContext = new AudioContext();
        this.audioProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
        this.audioSource = this.audioContext.createMediaStreamSource(this.stream);
        this.audioProcessor.addEventListener('audioprocess', this.handleAudioProcess);
        this.audioSource.connect(this.audioProcessor);
        this.audioProcessor.connect(this.audioContext.destination);
    }
};

prototype.unwatchAudioVolume = function() {
    if (this.audioContext) {
        this.audioProcessor.disconnect(this.audioContext.destination);
        this.audioSource.disconnect(this.audioProcessor);
        this.audioProcessor.removeEventListener('audioprocess', this.handleAudioProcess);
        this.audioContext = undefined;
        this.audioSource = undefined;
        this.audioProcessor = undefined;
    }
    this.volume = undefined;
};

/**
 * Release recording device
 */
prototype.releaseInput = function() {
    this.unwatchAudioVolume();
    this.unwatchStreamStatus();
    stopMediaStream(this.stream);
    this.stream = undefined;
    this.liveVideo = undefined;
    this.liveAudio = undefined;
};

/**
 * Revoke the blob URL of captured media and set them to undefined
 */
prototype.revokeBlobs = function() {
    if (this.capturedVideo) {
        URL.revokeObjectURL(this.capturedVideo.url);
        this.capturedVideo = undefined;
    }
    if (this.capturedAudio) {
        URL.revokeObjectURL(this.capturedAudio.url);
        this.capturedAudio = undefined;
    }
    if (this.capturedImage) {
        URL.revokeObjectURL(this.capturedImage.url);
        this.capturedImage = undefined;
    }
};

/**
 * Add captured media to the list of object, sans blob URLs
 *
 * @return {Object}
 */
prototype.extract = function() {
    var media = {};
    if (this.capturedVideo) {
        media.video = {
            blob: this.capturedVideo.blob,
            width: this.capturedVideo.width,
            height: this.capturedVideo.height,
            duration: this.capturedVideo.duration,
        };
    }
    if (this.capturedAudio) {
        media.audio = {
            blob: this.capturedAudio.blob,
            duration: this.capturedAudio.duration,
        };
    }
    if (this.capturedImage) {
        media.image = {
            blob: this.capturedImage.blob,
            width: this.capturedImage.width,
            height: this.capturedImage.height,
        };
    }
    return media;
};

prototype.reacquire = function() {
    this.status = 'initiating';
    this.releaseInput();
    this.notifyChange();
    return this.acquire();
};

prototype.choose = function(deviceID) {
    this.selectedDeviceID = deviceID;
    return this.reacquire();
};

prototype.clear = function() {
    this.revokeBlobs();
    if (this.liveVideo) {
        this.status = 'previewing';
    } else {
        this.status = undefined;
    }
    this.duration = undefined;
    this.notifyChange();
};

prototype.change = function() {
    var _this = this;
    if (!this.waitPromise) {
        this.waitPromise = new Promise(function(resolve, reject) {
            _this.waitResolve = resolve;
            _this.waitReject = reject;
        });
    }
    return this.waitPromise;
};

prototype.notifyChange = function() {
    var resolve = this.waitResolve;
    if (resolve) {
        this.waitPromise = null;
        this.waitResolve = null;
        this.waitReject = null;
        resolve();
    }
    var evt = new RelaksMediaCaptureEvent('change', this);
    this.triggerEvent(evt);
};

prototype.handleDeviceChange = function(evt) {
    if (this.scanningDevices) {
        return;
    }
    this.scanningDevices = true;

    var _this = this;
    var devicesBefore = this.devices;
    var constraints = {
        video: this.options.video,
        audio: this.options.audio,
    };
    getDevices(constraints).then(function(devices) {
        var newDevice = null;
        var useNewDevice = false;
        if (_this.status === 'initiating' || _this.status === 'previewing') {
            useNewDevice = _this.options.chooseNewDevice;
        }
        if (useNewDevice) {
            for (var i = 0; i < devices.length; i++) {
                var device = devices[i];
                var added = true;
                for (var j = 0; j < devicesBefore.length; j++) {
                    var deviceBefore = devicesBefore[j];
                    if (device.id === deviceBefore.id) {
                        added = false;
                        break;
                    }
                }
                if (added) {
                    newDevice = devices[i];
                    break;
                }
            }
        }
        _this.devices = devices;
        _this.scanningDevices = false;
        if (newDevice) {
            // use the new device
            _this.choose(newDevice.id);
        } else {
            // just note the change to the device list
            _this.notifyChange();
        }
    });
};

prototype.handleStreamEnd = function(evt) {
    if (this.stream) {
        var tracks = this.stream.getTracks();
        for (var i = 0; i < tracks.length; i++) {
            if (evt.target === tracks[i]) {
                if (this.status === 'previewing') {
                    this.reacquire();
                } else if (this.status === 'capturing' || this.status === 'paused') {
                    this.releaseInput();
                    this.stop();
                }
                break;
            }
        }
    }
};

prototype.handleAudioProcess = function(evt) {
    var samples = evt.inputBuffer.getChannelData(0);
    var max = 0;
    var count = samples.length;
    for (var i = 0; i < count; i++) {
        var s = samples[i];
        if (s > max) {
            max = s;
        }
    }
    var volume = Math.round(max * 100);
    if (volume !== this.volume) {
        this.volume = volume;
        this.notifyChange();
    }
};

prototype.handleMediaRecorderData = function(evt) {
    this.mediaRecorderBlobs.push(evt.data);
    if (this.options.segmentDuration) {
        var evt = new RelaksMediaCaptureEvent('chunk', this, { blob: evt.data });
        this.triggerEvent(evt);
    }
};

prototype.handleMediaRecorderStart = function(evt) {
    this.mediaRecorderInterval = setInterval(this.handleMediaRecorderInterval, 100);
    this.mediaRecorderStartTime = new Date;
    this.status = 'capturing';
    this.notifyChange();
};

prototype.handleMediaRecorderStop = function(evt) {
    clearInterval(this.mediaRecorderInterval);
    var _this = this;
    var blobs = this.mediaRecorderBlobs;
    if (blobs.length > 0) {
        var blob;
        if (blobs.length === 1) {
            blob = blobs[0];
        } else {
            blob = new Blob(blobs, { type: blobs[0].type });
        }
        var url = URL.createObjectURL(blob);
        if (this.liveVideo) {
            this.capturedVideo = {
                url: url,
                blob: blob,
                blobs: blobs,
                duration: this.duration,
                width: this.liveVideo.width,
                height: this.liveVideo.height,
            };
        } else if (this.liveAudio) {
            this.capturedAudio = {
                url: url,
                blob: blob,
                blobs: blobs,
                duration: this.duration,
            };
        }
        if (this.mediaRecorderStartTime) {
            var now = new Date;
            var elapsed = now - this.mediaRecorderStartTime;
            this.duration = this.mediaRecorderDuration + elapsed;
        }
        this.status = 'captured';
    } else {
        this.duration = undefined;
        this.status = 'previewing';
    }
    this.mediaRecorder = null;
    this.mediaRecorderBlobs = [];
    this.mediaRecorderInterval = 0;
    this.mediaRecorderStartTime = null;
    this.mediaRecorderDuration = 0;
    this.notifyChange();
    if (this.options.segmentDuration) {
        var evt = new RelaksMediaCaptureEvent('end', this);
        this.triggerEvent(evt);
    }
};

prototype.handleMediaRecorderPause = function(evt) {
    clearInterval(this.mediaRecorderInterval);

    var now = new Date;
    var elapsed = now - this.mediaRecorderStartTime;
    this.duration = this.mediaRecorderDuration + elapsed;
    this.mediaRecorderDuration = this.duration;
    this.mediaRecorderStartTime = null;
    this.status = 'paused';
    this.notifyChange();
};

prototype.handleMediaRecorderResume = prototype.handleMediaRecorderStart;

prototype.handleMediaRecorderInterval = function() {
    var now = new Date;
    var elapsed = now - this.mediaRecorderStartTime;
    this.duration = this.mediaRecorderDuration + elapsed;
    this.notifyChange();
};

function getMediaStream(constraints) {
    try {
        return navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
        return Promise.reject(err);
    }
}

function getVideoStreamMeta(stream) {
    return new Promise(function(resolve, reject) {
        var el = document.createElement('VIDEO');
        el.srcObject = stream;
        el.muted = true;
        // dimensions aren't always available when loadedmetadata fires
        // listening for additional event just in case
        el.onloadedmetadata =
        el.onloadeddata =
        el.oncanplay = function(evt) {
            if (resolve) {
                var meta;
                if (el.tagName === 'VIDEO') {
                    var w = el.videoWidth;
                    var h = el.videoHeight;
                    if (w && h) {
                        meta = { width: w, height: h };
                    }
                } else {
                    meta = {};
                }
                if (meta) {
                    resolve(meta);
                    resolve = null;
                    el.pause();
                    el.srcObject = null;
                }
            }
        };
        el.onerror = function(evt) {
            var err = new RelaksMediaCaptureError('Unable to obtain metadata');
            reject(err);
            el.pause();
        };
        el.play();
    });
}

function getVideoStreamSnapshot(stream) {
    return new Promise(function(resolve, reject) {
        var el = document.createElement('VIDEO');
        el.srcObject = stream;
        el.muted = true;
        el.oncanplay = function(evt) {
            if (resolve) {
                var w = el.videoWidth;
                var h = el.videoHeight;
                var canvas = document.createElement('CANVAS');
                canvas.width = w;
                canvas.height = h;
                var context = canvas.getContext('2d');
                context.drawImage(el, 0, 0, w, h);
                resolve(canvas);
                resolve = null;
                el.pause();
                el.srcObject = null;
            }
        };
        el.onerror = function(evt) {
            var err = new RelaksMediaCaptureError('Unable to capture image');
            reject(err);
            el.pause();
            el.srcObject = null;
        };
        el.play();
    });
}

/**
 * Stop all tracks of a media stream
 *
 * @param  {MediaStream} stream
 */
function stopMediaStream(stream) {
    // stop all tracks
    var tracks = stream.getTracks();
    for (var i = 0; i < tracks.length; i++) {
        tracks[i].stop();
    }
}

/**
 * Get list of devices for the given constraints, asking for permission if
 * necessary
 *
 * @param  {Object} constraints
 *
 * @return {Promise<Array<Object>>}
 */
function getDevices(constraints) {
    var kind;
    if (constraints.video) {
        kind = 'videoinput';
    } else if (constraints.audio) {
        kind = 'audioinput';
    }
    return enumerateDevices(kind).then(function(devices) {
        // we can't get the labels without obtaining permission first
        var labelless = 0;
        for (var i = 0; i < devices.length; i++) {
            if (!devices[i].label) {
                labelless++;
            }
        }
        if (labelless > 0 && labelless === devices.length) {
            // trigger request for permission
            return getMediaStream(constraints).then(function(stream) {
                stopMediaStream(stream);
                return enumerateDevices(kind);
            });
        } else {
            return devices;
        }
    }).then(function(devices) {
        return devices.map(function(device) {
            return {
                id: device.deviceId,
                label: device.label,
            };
        });
    });
}

/**
 * Enumerate a particular kind of devices
 *
 * @param  {Object} contraints
 *
 * @return {Promise<Array<Object>>}
 */
function enumerateDevices(kind) {
    var mediaDevices = navigator.mediaDevices;
    if (mediaDevices && mediaDevices.enumerateDevices) {
        return mediaDevices.enumerateDevices().then(function(devices) {
            return devices.filter(function(device) {
                return (device.kind === kind);
            });
        }).catch(function(err) {
            return [];
        });
    } else {
        return Promise.resolve([]);
    }
}

function chooseDevice(devices, preferred) {
    if (preferred) {
        for (var i = 0; i < devices.length; i++) {
            var device = devices[i];
            if (device.id === preferred) {
                return device;
            }
        }
        var fragment = preferred.toLowerCase();
        for (var i = 0; i < devices.length; i++) {
            var device = devices[i];
            var label = device.label
            if (label && label.toLowerCase().indexOf(fragment) !== -1) {
                return device;
            }
        }
    }
    return devices[0];
}

/**
 * Save canvas contents to a blob using toBlob() if browser supports it,
 * otherwise fallback to toDataURL()
 *
 * @param  {HTMLCanvasElement} canvas
 * @param  {String} mimeType
 * @param  {Number} quality
 *
 * @return {Promise<Blob>}
 */
function saveCanvasContents(canvas, mimeType, quality) {
    return new Promise(function(resolve, reject) {
        if (typeof(canvas.toBlob) === 'function') {
            canvas.toBlob(resolve, mimeType, 90);
        } else {
            try {
                var dataURL = canvas.toDataURL(mimeType, quality);
                var xhr = new XMLHttpRequest;
                xhr.responseType = 'blob';
                xhr.onload = function(evt) {
                    if (xhr.status >= 400) {
                        reject(new RelaksMediaCaptureError('Error parsing data URL'));
                    } else {
                        resolve(xhr.response);
                    }
                };
                xhr.onerror = function() {
                    reject(new RelaksMediaCaptureError('Unable to load image'));
                };
                xhr.open('GET', dataURL, true);
                xhr.send();
            } catch (err) {
                reject(err);
            }
        }
    });
}

function RelaksMediaCaptureEvent(type, target, props) {
    GenericEvent.call(this, type, target, props);
}

function RelaksMediaCaptureError(message) {
    this.message = message;
}

RelaksMediaCaptureError.prototype = Object.create(Error.prototype)

module.exports = RelaksMediaCapture;
