/**
 * Roland AIRA Compact S-1 Tweak Synth - Web Audio Sound Engine
 * True Analog Variable Pulse Width Modulation (PWM), OSC Draw, OSC Chop, Resonant 24dB VCF & Roland FX Chain
 */

class S1AudioEngine {
  constructor() {
    this.ctx = null;
    this.isInitialized = false;
    this.isMuted = false;

    // Master Parameters
    this.params = {
      masterVolume: 0.8,
      tempo: 120,
      portamento: 0.0,
      voiceMode: 'poly', // poly, mono, unison, chord
      chordType: 'min7', // maj, min, min7, maj7, sus4

      // Oscillators
      oscSaw: 0.8,
      oscSquare: 0.8,
      oscPwm: 0.5,
      oscSub: 0.3,
      subMode: 'sub1', // sub1 (-1 oct), sub2 (-2 oct), subPulse
      oscNoise: 0.0,
      oscDrawMix: 0.0,
      oscChop: 0.0,
      oscChopComb: 0.2,

      // Filter
      filterCutoff: 4500,
      filterResonance: 4.0,
      filterHpf: 10,
      filterEnvDepth: 0.5,
      filterKeyFollow: 0.5,
      drive: 0.1,

      // Envelopes
      envAttack: 0.005,
      envDecay: 0.35,
      envSustain: 0.2,
      envRelease: 0.4,

      // LFO
      lfoRate: 3.0,
      lfoWave: 'triangle', // triangle, saw, square, sh
      lfoPitchDepth: 0.0,
      lfoFilterDepth: 0.0,
      lfoPwmDepth: 0.4,

      // FX
      fxChorusSend: 0.4,
      chorusMode: 'type1', // off, type1, type2, type12
      fxDelaySend: 0.25,
      fxDelayTime: 0.375,
      fxDelayFeedback: 0.4,
      fxReverbSend: 0.3
    };

    // Drawn Waveform Points (Default Sine)
    this.drawnWavePoints = new Float32Array(64);
    for (let i = 0; i < 64; i++) {
      this.drawnWavePoints[i] = Math.sin((i / 64) * Math.PI * 2);
    }
    this.customPeriodicWave = null;

    // Voice pool (4 Voices)
    this.maxVoices = 4;
    this.voices = [];
    this.activeVoiceMap = new Map();
    this.lastMonoNote = null;
    this.lastMonoFreq = 440;

    // Recording buffer
    this.recorder = null;
    this.recordedChunks = [];
    this.isRecording = false;

    // PWM Comparator Curve Cache
    this.pwmCurve = this.createPwmCurve();

    // Callbacks
    this.onNoteTrigger = null;
  }

  createPwmCurve() {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 30.0);
    }
    return curve;
  }

  init() {
    if (this.isInitialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
      return;
    }

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();

      // Build Master Bus & Effects Chain
      this.setupAudioGraph();

      // Create Noise Buffer & DC Buffer
      this.createNoiseBuffer();

      // Generate Custom Periodic Wave
      this.updateCustomPeriodicWave();

      // Initialize 4 Polyphonic Voices
      this.voices = [];
      for (let i = 0; i < this.maxVoices; i++) {
        this.voices.push(new S1Voice(this, i));
      }

      this.isInitialized = true;
    } catch (e) {
      console.error('AudioEngine initialization error:', e);
    }
  }

  ensureAudioContext() {
    if (!this.isInitialized) {
      this.init();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    try {
      if (this.ctx) {
        const buffer = this.ctx.createBuffer(1, 1, 22050);
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.ctx.destination);
        source.start(0);
      }
    } catch (e) {}
  }

  setupAudioGraph() {
    // Synth Voice Bus
    this.voiceBus = this.ctx.createGain();
    this.voiceBus.gain.value = 1.0;

    // Master Drive / Waveshaper
    this.driveNode = this.ctx.createWaveShaper();
    this.updateDriveCurve();

    // Master Volume Gain
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.params.masterVolume;

    // Master Compressor / Limiter
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.setValueAtTime(-1.0, this.ctx.currentTime);
    this.limiter.knee.setValueAtTime(4.0, this.ctx.currentTime);
    this.limiter.ratio.setValueAtTime(16.0, this.ctx.currentTime);
    this.limiter.attack.setValueAtTime(0.002, this.ctx.currentTime);
    this.limiter.release.setValueAtTime(0.1, this.ctx.currentTime);

    // Master Analyser (for Oscilloscope)
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.8;

    // Setup FX Chain
    this.setupChorus();
    this.setupDelay();
    this.setupReverb();

    // Recording Destination
    try {
      if (this.ctx.createMediaStreamDestination) {
        this.recDestination = this.ctx.createMediaStreamDestination();
      }
    } catch (e) {
      this.recDestination = null;
    }

    // Wiring Audio Graph
    this.voiceBus.connect(this.driveNode);
    this.driveNode.connect(this.masterGain);

    // Dry path
    this.masterGain.connect(this.limiter);

    // FX sends
    this.masterGain.connect(this.chorusInput);
    this.masterGain.connect(this.delayInput);
    this.masterGain.connect(this.reverbInput);

    // FX returns -> Limiter
    this.chorusOutput.connect(this.limiter);
    this.delayOutput.connect(this.limiter);
    this.reverbOutput.connect(this.limiter);

    // Limiter -> Analyser -> Output & Recorder
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    if (this.recDestination) {
      this.limiter.connect(this.recDestination);
    }
  }

  updateDriveCurve() {
    if (!this.driveNode) return;
    const k = this.params.drive * 30;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      if (k === 0) {
        curve[i] = x;
      } else {
        curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
      }
    }
    this.driveNode.curve = curve;
  }

  createNoiseBuffer() {
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
  }

  // =========================================================================
  // EFFECTS PROCESSORS
  // =========================================================================
  setupChorus() {
    this.chorusInput = this.ctx.createGain();
    this.chorusOutput = this.ctx.createGain();
    this.chorusGain = this.ctx.createGain();
    this.chorusGain.gain.value = this.params.fxChorusSend;

    this.chorusDelayL = this.ctx.createDelay();
    this.chorusDelayR = this.ctx.createDelay();
    this.chorusDelayL.delayTime.value = 0.007;
    this.chorusDelayR.delayTime.value = 0.009;

    this.chorusLfoL = this.ctx.createOscillator();
    this.chorusLfoR = this.ctx.createOscillator();
    this.chorusLfoDepthL = this.ctx.createGain();
    this.chorusLfoDepthR = this.ctx.createGain();

    this.chorusLfoL.frequency.value = 0.5;
    this.chorusLfoR.frequency.value = 0.8;
    this.chorusLfoDepthL.gain.value = 0.0025;
    this.chorusLfoDepthR.gain.value = 0.0035;

    this.chorusLfoL.connect(this.chorusLfoDepthL);
    this.chorusLfoR.connect(this.chorusLfoDepthR);
    this.chorusLfoDepthL.connect(this.chorusDelayL.delayTime);
    this.chorusLfoDepthR.connect(this.chorusDelayR.delayTime);

    this.chorusLfoL.start();
    this.chorusLfoR.start();

    const merger = this.ctx.createChannelMerger(2);
    this.chorusInput.connect(this.chorusDelayL);
    this.chorusInput.connect(this.chorusDelayR);
    this.chorusDelayL.connect(merger, 0, 0);
    this.chorusDelayR.connect(merger, 0, 1);

    merger.connect(this.chorusGain);
    this.chorusGain.connect(this.chorusOutput);
    this.updateChorusMode();
  }

  updateChorusMode() {
    if (!this.chorusGain || !this.ctx) return;
    const mode = this.params.chorusMode;
    const now = this.ctx.currentTime;
    if (mode === 'off') {
      this.chorusGain.gain.setValueAtTime(0, now);
    } else if (mode === 'type1') {
      this.chorusLfoL.frequency.setValueAtTime(0.5, now);
      this.chorusLfoR.frequency.setValueAtTime(0.5, now);
      this.chorusLfoDepthL.gain.setValueAtTime(0.002, now);
      this.chorusLfoDepthR.gain.setValueAtTime(0.0025, now);
      this.chorusGain.gain.setValueAtTime(this.params.fxChorusSend, now);
    } else if (mode === 'type2') {
      this.chorusLfoL.frequency.setValueAtTime(0.9, now);
      this.chorusLfoR.frequency.setValueAtTime(0.95, now);
      this.chorusLfoDepthL.gain.setValueAtTime(0.0035, now);
      this.chorusLfoDepthR.gain.setValueAtTime(0.004, now);
      this.chorusGain.gain.setValueAtTime(this.params.fxChorusSend * 1.2, now);
    } else if (mode === 'type12') {
      this.chorusLfoL.frequency.setValueAtTime(1.4, now);
      this.chorusLfoR.frequency.setValueAtTime(1.5, now);
      this.chorusLfoDepthL.gain.setValueAtTime(0.0045, now);
      this.chorusLfoDepthR.gain.setValueAtTime(0.005, now);
      this.chorusGain.gain.setValueAtTime(this.params.fxChorusSend * 1.3, now);
    }
  }

  setupDelay() {
    this.delayInput = this.ctx.createGain();
    this.delayOutput = this.ctx.createGain();
    this.delayGain = this.ctx.createGain();
    this.delayGain.gain.value = this.params.fxDelaySend;

    this.delayNode = this.ctx.createDelay(2.0);
    this.delayNode.delayTime.value = this.params.fxDelayTime;

    this.delayFeedback = this.ctx.createGain();
    this.delayFeedback.gain.value = this.params.fxDelayFeedback;

    this.delayFilter = this.ctx.createBiquadFilter();
    this.delayFilter.type = 'lowpass';
    this.delayFilter.frequency.value = 3500;

    this.delayInput.connect(this.delayNode);
    this.delayNode.connect(this.delayFilter);
    this.delayFilter.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayNode);
    this.delayFilter.connect(this.delayGain);
    this.delayGain.connect(this.delayOutput);
  }

  setupReverb() {
    this.reverbInput = this.ctx.createGain();
    this.reverbOutput = this.ctx.createGain();
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = this.params.fxReverbSend;

    this.convolver = this.ctx.createConvolver();
    this.generateReverbImpulse(2.0, 2.0);

    this.reverbInput.connect(this.convolver);
    this.convolver.connect(this.reverbGain);
    this.reverbGain.connect(this.reverbOutput);
  }

  generateReverbImpulse(duration, decay) {
    if (!this.ctx) return;
    const sampleRate = this.ctx.sampleRate;
    const length = Math.floor(sampleRate * duration);
    const impulse = this.ctx.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const n = length - i;
      const factor = Math.pow(n / length, decay);
      left[i] = (Math.random() * 2 - 1) * factor;
      right[i] = (Math.random() * 2 - 1) * factor;
    }
    this.convolver.buffer = impulse;
  }

  // =========================================================================
  // OSC DRAW / FOURIER SYNTHESIS
  // =========================================================================
  setDrawnWaveform(points) {
    this.drawnWavePoints = points;
    this.updateCustomPeriodicWave();
  }

  updateCustomPeriodicWave() {
    if (!this.ctx) return;
    const numHarmonics = 64;
    const real = new Float32Array(numHarmonics);
    const imag = new Float32Array(numHarmonics);
    const N = this.drawnWavePoints.length;

    real[0] = 0;
    imag[0] = 0;

    for (let k = 1; k < numHarmonics; k++) {
      let sumReal = 0;
      let sumImag = 0;
      for (let n = 0; n < N; n++) {
        const angle = (2 * Math.PI * k * n) / N;
        sumReal += this.drawnWavePoints[n] * Math.cos(angle);
        sumImag += this.drawnWavePoints[n] * Math.sin(angle);
      }
      real[k] = sumReal / N;
      imag[k] = -sumImag / N;
    }

    try {
      this.customPeriodicWave = this.ctx.createPeriodicWave(real, imag);
      this.voices.forEach(v => v.updatePeriodicWave(this.customPeriodicWave));
    } catch (e) {
      console.warn('PeriodicWave creation warning:', e);
    }
  }

  // =========================================================================
  // PARAMETER UPDATES
  // =========================================================================
  setParam(name, value) {
    this.params[name] = value;
    const now = this.ctx ? this.ctx.currentTime : 0;

    switch (name) {
      case 'masterVolume':
        if (this.masterGain && this.ctx) {
          this.masterGain.gain.setValueAtTime(value, now);
        }
        break;
      case 'drive':
        this.updateDriveCurve();
        break;
      case 'fxChorusSend':
        if (this.chorusGain && this.ctx) {
          this.chorusGain.gain.setValueAtTime(value, now);
        }
        break;
      case 'chorusMode':
        this.updateChorusMode();
        break;
      case 'fxDelaySend':
        if (this.delayGain && this.ctx) {
          this.delayGain.gain.setValueAtTime(value, now);
        }
        break;
      case 'fxDelayTime':
        if (this.delayNode && this.ctx) {
          this.delayNode.delayTime.setValueAtTime(value, now);
        }
        break;
      case 'fxDelayFeedback':
        if (this.delayFeedback && this.ctx) {
          this.delayFeedback.gain.setValueAtTime(value, now);
        }
        break;
      case 'fxReverbSend':
        if (this.reverbGain && this.ctx) {
          this.reverbGain.gain.setValueAtTime(value, now);
        }
        break;
      default:
        this.voices.forEach(v => v.updateParam(name, value));
        break;
    }
  }

  // =========================================================================
  // NOTE HANDLING & VOICE ALLOCATION
  // =========================================================================
  midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  triggerNoteOn(midiNote, velocity = 1.0) {
    this.ensureAudioContext();
    if (this.isMuted || this.voices.length === 0) return;

    const baseFreq = this.midiToFreq(midiNote);
    const mode = this.params.voiceMode;

    if (mode === 'mono') {
      const voice = this.voices[0];
      if (voice) {
        const prevFreq = this.lastMonoFreq || baseFreq;
        voice.triggerOn(midiNote, baseFreq, velocity, prevFreq, this.params.portamento);
        this.lastMonoNote = midiNote;
        this.lastMonoFreq = baseFreq;
        this.activeVoiceMap.set(midiNote, voice);
      }
    } 
    else if (mode === 'unison') {
      const detunes = [-12, -4, 4, 12];
      for (let i = 0; i < this.maxVoices; i++) {
        const v = this.voices[i];
        if (v) {
          const detunedFreq = baseFreq * Math.pow(2, detunes[i] / 1200);
          v.triggerOn(midiNote, detunedFreq, velocity * 0.45, baseFreq, this.params.portamento);
        }
      }
      this.activeVoiceMap.set(midiNote, this.voices);
    } 
    else if (mode === 'chord') {
      const intervals = this.getChordIntervals(this.params.chordType);
      for (let i = 0; i < Math.min(intervals.length, this.maxVoices); i++) {
        const v = this.voices[i];
        if (v) {
          const chordMidi = midiNote + intervals[i];
          const chordFreq = this.midiToFreq(chordMidi);
          v.triggerOn(chordMidi, chordFreq, velocity * 0.5, chordFreq, 0);
        }
      }
      this.activeVoiceMap.set(midiNote, this.voices);
    } 
    else {
      let voice = this.voices.find(v => !v.isPlaying);
      if (!voice) {
        voice = this.voices.reduce((oldest, current) => 
          current.lastTriggerTime < oldest.lastTriggerTime ? current : oldest
        );
      }
      if (voice) {
        voice.triggerOn(midiNote, baseFreq, velocity, baseFreq, 0);
        this.activeVoiceMap.set(midiNote, voice);
      }
    }

    if (this.onNoteTrigger) {
      this.onNoteTrigger(midiNote, true);
    }
  }

  triggerNoteOff(midiNote) {
    if (!this.isInitialized) return;
    const entry = this.activeVoiceMap.get(midiNote);
    if (!entry) return;

    if (Array.isArray(entry)) {
      entry.forEach(v => v.triggerOff());
    } else {
      entry.triggerOff();
    }
    this.activeVoiceMap.delete(midiNote);

    if (this.onNoteTrigger) {
      this.onNoteTrigger(midiNote, false);
    }
  }

  allNotesOff() {
    this.voices.forEach(v => v.triggerOff(true));
    this.activeVoiceMap.clear();
  }

  getChordIntervals(type) {
    switch (type) {
      case 'maj': return [0, 4, 7, 12];
      case 'min': return [0, 3, 7, 12];
      case 'maj7': return [0, 4, 7, 11];
      case 'min7': return [0, 3, 7, 10];
      case 'sus4': return [0, 5, 7, 12];
      default: return [0, 3, 7, 10];
    }
  }

  // =========================================================================
  // AUDIO RECORDING & WAV/AUDIO EXPORT
  // =========================================================================
  startRecording() {
    this.ensureAudioContext();
    if (!this.recDestination) return false;
    this.recordedChunks = [];
    try {
      let options = {};
      if (typeof MediaRecorder !== 'undefined') {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm')) {
          options = { mimeType: 'audio/webm' };
        } else if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4')) {
          options = { mimeType: 'audio/mp4' };
        }
      }
      this.recorder = new MediaRecorder(this.recDestination.stream, options);
      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
      };
      this.recorder.start(100);
      this.isRecording = true;
      return true;
    } catch (e) {
      console.warn('Recording not supported on this browser:', e);
      return false;
    }
  }

  stopRecording() {
    if (!this.recorder || !this.isRecording) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.recorder.onstop = () => {
        const mime = (this.recorder && this.recorder.mimeType) || 'audio/webm';
        const blob = new Blob(this.recordedChunks, { type: mime });
        this.isRecording = false;
        resolve(blob);
      };
      this.recorder.stop();
    });
  }
}

// ===========================================================================
// S-1 SINGLE SYNTH VOICE ARCHITECTURE WITH VARIABLE PWM COMPARATOR
// ===========================================================================
class S1Voice {
  constructor(engine, index) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.index = index;

    this.isPlaying = false;
    this.currentNote = null;
    this.currentFreq = 440;
    this.lastTriggerTime = 0;

    this.setupNodes();
  }

  setupNodes() {
    const ctx = this.ctx;

    // Main Voice Gain
    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = 0;

    // 1. Saw Oscillator
    this.oscSaw = ctx.createOscillator();
    this.oscSaw.type = 'sawtooth';
    this.gainSaw = ctx.createGain();
    this.gainSaw.gain.value = this.engine.params.oscSaw;
    this.oscSaw.connect(this.gainSaw);

    // 2. TRUE VARIABLE PULSE WIDTH MODULATION (PWM) ENGINE
    // Base Saw wave into comparator waveshaper
    this.oscPulseSaw = ctx.createOscillator();
    this.oscPulseSaw.type = 'sawtooth';

    // DC bias source for manual PWM width control
    if (ctx.createConstantSource) {
      this.pwmDcSource = ctx.createConstantSource();
      this.pwmDcSource.offset.value = 1.0;
      this.pwmDcSource.start(0);
    } else {
      const dcBuf = ctx.createBuffer(1, 128, ctx.sampleRate);
      dcBuf.getChannelData(0).fill(1.0);
      this.pwmDcSource = ctx.createBufferSource();
      this.pwmDcSource.buffer = dcBuf;
      this.pwmDcSource.loop = true;
      this.pwmDcSource.start(0);
    }

    this.pwmBiasGain = ctx.createGain();
    this.pwmBiasGain.gain.value = (this.engine.params.oscPwm - 0.5) * 1.6;
    this.pwmDcSource.connect(this.pwmBiasGain);

    // PWM Summer node: Saw + Manual DC Bias + LFO PWM Modulation
    this.pwmSummer = ctx.createGain();
    this.oscPulseSaw.connect(this.pwmSummer);
    this.pwmBiasGain.connect(this.pwmSummer);

    // WaveShaper Comparator for sharp analog pulse edges
    this.pwmShaper = ctx.createWaveShaper();
    this.pwmShaper.curve = this.engine.pwmCurve;
    this.pwmSummer.connect(this.pwmShaper);

    this.gainPulse = ctx.createGain();
    this.gainPulse.gain.value = this.engine.params.oscSquare;
    this.pwmShaper.connect(this.gainPulse);

    // 3. Sub Oscillator
    this.oscSub = ctx.createOscillator();
    this.oscSub.type = 'square';
    this.gainSub = ctx.createGain();
    this.gainSub.gain.value = this.engine.params.oscSub;
    this.oscSub.connect(this.gainSub);

    // 4. White Noise Generator
    this.noiseSource = ctx.createBufferSource();
    if (this.engine.noiseBuffer) {
      this.noiseSource.buffer = this.engine.noiseBuffer;
    }
    this.noiseSource.loop = true;
    this.gainNoise = ctx.createGain();
    this.gainNoise.gain.value = this.engine.params.oscNoise;
    this.noiseSource.connect(this.gainNoise);

    // 5. OSC DRAW Custom Periodic Wave Oscillator
    this.oscDraw = ctx.createOscillator();
    if (this.engine.customPeriodicWave) {
      try {
        this.oscDraw.setPeriodicWave(this.engine.customPeriodicWave);
      } catch (e) {}
    }
    this.gainDraw = ctx.createGain();
    this.gainDraw.gain.value = this.engine.params.oscDrawMix;
    this.oscDraw.connect(this.gainDraw);

    // 6. OSC CHOP Comb / Harmonic Slicer
    this.chopDelay = ctx.createDelay(0.05);
    this.chopDelay.delayTime.value = 0.002;
    this.chopFeedback = ctx.createGain();
    this.chopFeedback.gain.value = this.engine.params.oscChopComb;
    this.chopDelay.connect(this.chopFeedback);
    this.chopFeedback.connect(this.chopDelay);

    this.chopWetGain = ctx.createGain();
    this.chopWetGain.gain.value = this.engine.params.oscChop;
    this.chopDelay.connect(this.chopWetGain);

    // Oscillator Mixer Bus
    this.oscMixer = ctx.createGain();
    this.gainSaw.connect(this.oscMixer);
    this.gainPulse.connect(this.oscMixer);
    this.gainSub.connect(this.oscMixer);
    this.gainNoise.connect(this.oscMixer);
    this.gainDraw.connect(this.oscMixer);

    this.oscMixer.connect(this.chopDelay);

    // 7. Filters
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = this.engine.params.filterHpf;

    this.lpf1 = ctx.createBiquadFilter();
    this.lpf1.type = 'lowpass';
    this.lpf1.frequency.value = this.engine.params.filterCutoff;
    this.lpf1.Q.value = this.engine.params.filterResonance;

    this.lpf2 = ctx.createBiquadFilter();
    this.lpf2.type = 'lowpass';
    this.lpf2.frequency.value = this.engine.params.filterCutoff;
    this.lpf2.Q.value = this.engine.params.filterResonance * 0.5;

    // 8. LFO Modulation Matrix
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = this.engine.params.lfoRate;
    this.setLfoWave(this.engine.params.lfoWave);

    // LFO -> Pitch (Vibrato)
    this.lfoPitchGain = ctx.createGain();
    this.lfoPitchGain.gain.value = this.engine.params.lfoPitchDepth * 200;
    this.lfo.connect(this.lfoPitchGain);
    this.lfoPitchGain.connect(this.oscSaw.detune);
    this.lfoPitchGain.connect(this.oscPulseSaw.detune);
    this.lfoPitchGain.connect(this.oscDraw.detune);

    // LFO -> Filter Cutoff (Wah / Growl)
    this.lfoFilterGain = ctx.createGain();
    this.lfoFilterGain.gain.value = this.engine.params.lfoFilterDepth * 3000;
    this.lfo.connect(this.lfoFilterGain);
    this.lfoFilterGain.connect(this.lpf1.frequency);
    this.lfoFilterGain.connect(this.lpf2.frequency);

    // LFO -> PWM Depth (Roland Juno / SH-101 Pulse Width Sweep)
    this.lfoPwmGain = ctx.createGain();
    this.lfoPwmGain.gain.value = this.engine.params.lfoPwmDepth * 0.85;
    this.lfo.connect(this.lfoPwmGain);
    this.lfoPwmGain.connect(this.pwmSummer);

    // Signal Routing
    this.oscMixer.connect(this.hpf);
    this.chopWetGain.connect(this.hpf);
    this.hpf.connect(this.lpf1);
    this.lpf1.connect(this.lpf2);
    this.lpf2.connect(this.voiceGain);
    this.voiceGain.connect(this.engine.voiceBus);

    // Start continuous oscillators
    this.oscSaw.start(0);
    this.oscPulseSaw.start(0);
    this.oscSub.start(0);
    this.noiseSource.start(0);
    this.oscDraw.start(0);
    this.lfo.start(0);
  }

  setLfoWave(shape) {
    if (shape === 'triangle') this.lfo.type = 'triangle';
    else if (shape === 'saw') this.lfo.type = 'sawtooth';
    else if (shape === 'square') this.lfo.type = 'square';
    else if (shape === 'sh') this.lfo.type = 'square';
  }

  updatePeriodicWave(pWave) {
    if (pWave && this.oscDraw) {
      try {
        this.oscDraw.setPeriodicWave(pWave);
      } catch (e) {}
    }
  }

  updateParam(name, value) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;

    switch (name) {
      case 'oscSaw':
        this.gainSaw.gain.setValueAtTime(value, now);
        break;
      case 'oscSquare':
        this.gainPulse.gain.setValueAtTime(value, now);
        break;
      case 'oscPwm':
        if (this.pwmBiasGain) {
          this.pwmBiasGain.gain.setValueAtTime((value - 0.5) * 1.6, now);
        }
        break;
      case 'lfoPwmDepth':
        if (this.lfoPwmGain) {
          this.lfoPwmGain.gain.setValueAtTime(value * 0.85, now);
        }
        break;
      case 'oscSub':
        this.gainSub.gain.setValueAtTime(value, now);
        break;
      case 'subMode':
        this.updateSubFrequency(this.currentFreq || 440);
        break;
      case 'oscNoise':
        this.gainNoise.gain.setValueAtTime(value, now);
        break;
      case 'oscDrawMix':
        this.gainDraw.gain.setValueAtTime(value, now);
        break;
      case 'oscChop':
        this.chopWetGain.gain.setValueAtTime(value, now);
        break;
      case 'oscChopComb':
        this.chopFeedback.gain.setValueAtTime(Math.min(value, 0.85), now);
        break;
      case 'filterCutoff':
        this.lpf1.frequency.setValueAtTime(value, now);
        this.lpf2.frequency.setValueAtTime(value, now);
        break;
      case 'filterResonance':
        this.lpf1.Q.setValueAtTime(value, now);
        this.lpf2.Q.setValueAtTime(value * 0.5, now);
        break;
      case 'filterHpf':
        this.hpf.frequency.setValueAtTime(value, now);
        break;
      case 'lfoRate':
        this.lfo.frequency.setValueAtTime(value, now);
        break;
      case 'lfoWave':
        this.setLfoWave(value);
        break;
      case 'lfoPitchDepth':
        this.lfoPitchGain.gain.setValueAtTime(value * 200, now);
        break;
      case 'lfoFilterDepth':
        this.lfoFilterGain.gain.setValueAtTime(value * 3000, now);
        break;
    }
  }

  updateSubFrequency(freq) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const mode = this.engine.params.subMode;
    let subFreq = freq * 0.5;
    if (mode === 'sub2') subFreq = freq * 0.25;
    this.oscSub.frequency.setValueAtTime(subFreq, now);
  }

  triggerOn(midiNote, freq, velocity = 1.0, prevFreq = freq, glideTime = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const p = this.engine.params;

    this.isPlaying = true;
    this.currentNote = midiNote;
    this.currentFreq = freq;
    this.lastTriggerTime = performance.now();

    const safeFreq = Math.max(20, Math.min(20000, freq));
    const safePrevFreq = Math.max(20, Math.min(20000, prevFreq || freq));

    this.oscSaw.frequency.cancelScheduledValues(now);
    this.oscPulseSaw.frequency.cancelScheduledValues(now);
    this.oscDraw.frequency.cancelScheduledValues(now);

    if (glideTime > 0.005) {
      this.oscSaw.frequency.setValueAtTime(safePrevFreq, now);
      this.oscPulseSaw.frequency.setValueAtTime(safePrevFreq, now);
      this.oscDraw.frequency.setValueAtTime(safePrevFreq, now);

      this.oscSaw.frequency.exponentialRampToValueAtTime(safeFreq, now + glideTime);
      this.oscPulseSaw.frequency.exponentialRampToValueAtTime(safeFreq, now + glideTime);
      this.oscDraw.frequency.exponentialRampToValueAtTime(safeFreq, now + glideTime);
    } else {
      this.oscSaw.frequency.setValueAtTime(safeFreq, now);
      this.oscPulseSaw.frequency.setValueAtTime(safeFreq, now);
      this.oscDraw.frequency.setValueAtTime(safeFreq, now);
    }

    this.updateSubFrequency(safeFreq);

    const chopDelayT = Math.max(0.0005, Math.min(0.04, 1 / (safeFreq * (1 + p.oscPwm * 4))));
    this.chopDelay.delayTime.cancelScheduledValues(now);
    this.chopDelay.delayTime.setValueAtTime(chopDelayT, now);

    const keyFollowOffset = (midiNote - 60) * 40 * p.filterKeyFollow;
    const targetCutoff = Math.max(20, Math.min(18000, p.filterCutoff + keyFollowOffset));

    const envPeakCutoff = Math.max(20, Math.min(20000, targetCutoff + (p.filterEnvDepth * 8000)));
    const envSustainCutoff = Math.max(20, Math.min(20000, targetCutoff + (p.filterEnvDepth * 8000 * p.envSustain)));

    this.lpf1.frequency.cancelScheduledValues(now);
    this.lpf2.frequency.cancelScheduledValues(now);
    this.lpf1.frequency.setValueAtTime(targetCutoff, now);
    this.lpf2.frequency.setValueAtTime(targetCutoff, now);

    const attackTime = Math.max(0.003, p.envAttack);
    const decayTime = Math.max(0.01, p.envDecay);
    const attackEnd = now + attackTime;
    const decayEnd = attackEnd + decayTime;

    this.lpf1.frequency.linearRampToValueAtTime(envPeakCutoff, attackEnd);
    this.lpf2.frequency.linearRampToValueAtTime(envPeakCutoff, attackEnd);
    this.lpf1.frequency.exponentialRampToValueAtTime(Math.max(20, envSustainCutoff), decayEnd);
    this.lpf2.frequency.exponentialRampToValueAtTime(Math.max(20, envSustainCutoff), decayEnd);

    const currentGain = Math.max(0.0001, this.voiceGain.gain.value);
    this.voiceGain.gain.cancelScheduledValues(now);
    this.voiceGain.gain.setValueAtTime(currentGain, now);

    const targetVol = Math.max(0.01, velocity * 0.75);
    this.voiceGain.gain.linearRampToValueAtTime(targetVol, attackEnd);
    const sustainVol = Math.max(0.0001, targetVol * Math.max(0.01, p.envSustain));
    this.voiceGain.gain.exponentialRampToValueAtTime(sustainVol, decayEnd);
  }

  triggerOff(instant = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const p = this.engine.params;

    this.isPlaying = false;
    this.currentNote = null;

    this.voiceGain.gain.cancelScheduledValues(now);
    this.lpf1.frequency.cancelScheduledValues(now);
    this.lpf2.frequency.cancelScheduledValues(now);

    if (instant) {
      this.voiceGain.gain.setValueAtTime(0, now);
      return;
    }

    const currentGain = Math.max(0.0001, this.voiceGain.gain.value);
    const relTime = Math.max(0.01, p.envRelease);
    this.voiceGain.gain.setValueAtTime(currentGain, now);
    this.voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + relTime);
    this.voiceGain.gain.setValueAtTime(0, now + relTime + 0.02);
  }
}

window.S1AudioEngine = S1AudioEngine;
