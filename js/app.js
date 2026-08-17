/**
 * Roland AIRA Compact S-1 Tweak Synth - Application Bootstrap & Keyboard Handlers
 */

document.addEventListener('DOMContentLoaded', () => {
  // Initialize Audio Engine & Sequencer
  const audioEngine = new S1AudioEngine();
  const sequencer = new S1Sequencer(audioEngine);
  const uiController = new S1UIController(audioEngine, sequencer);

  // Key map for computer QWERTY keyboard playing
  const KEY_NOTE_MAP = {
    'z': 0,  // C
    's': 1,  // C#
    'x': 2,  // D
    'd': 3,  // D#
    'c': 4,  // E
    'v': 5,  // F
    'g': 6,  // F#
    'b': 7,  // G
    'h': 8,  // G#
    'n': 9,  // A
    'j': 10, // A#
    'm': 11, // B
    ',': 12, // C+1
    'l': 13, // C#+1
    '.': 14, // D+1
    ';': 15  // D#+1
  };

  const activeComputerKeys = new Map();

  window.addEventListener('keydown', (e) => {
    // Prevent default scrolling for Space
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      sequencer.togglePlay();
      return;
    }

    // Ignore if typing in text inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
      return;
    }

    const key = e.key.toLowerCase();
    if (KEY_NOTE_MAP[key] !== undefined && !activeComputerKeys.has(key)) {
      const noteOffset = KEY_NOTE_MAP[key];
      const midiNote = (uiController.currentOctave * 12) + noteOffset;

      audioEngine.triggerNoteOn(midiNote, 0.9);
      activeComputerKeys.set(key, midiNote);

      // Visual highlight on corresponding step key
      const stepKey = document.querySelector(`.step-key[data-step="${noteOffset}"]`);
      if (stepKey) stepKey.classList.add('key-pressed');
    }
  });

  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (activeComputerKeys.has(key)) {
      const midiNote = activeComputerKeys.get(key);
      audioEngine.triggerNoteOff(midiNote);
      activeComputerKeys.delete(key);

      const noteOffset = KEY_NOTE_MAP[key];
      const stepKey = document.querySelector(`.step-key[data-step="${noteOffset}"]`);
      if (stepKey) stepKey.classList.remove('key-pressed');
    }
  });

  // Global first-gesture audio unlock
  const unlockAudio = () => {
    if (audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
      audioEngine.ctx.resume();
    }
    window.removeEventListener('click', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
  window.addEventListener('click', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  console.log('Roland AIRA Compact S-1 Tweak Synth Groovebox Ready!');
});
