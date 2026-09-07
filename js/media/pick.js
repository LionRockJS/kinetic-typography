// Choosing files. Where the File System Access API exists the picker hands back
// a handle alongside the file, which is what lets a later session reopen the
// same source without another trip through the file dialog. Everywhere else the
// caller falls back to the hidden <input type="file"> the app has always used.

const AUDIO_TYPES = [{
  description: 'Audio',
  // Voiceovers are routinely delivered as .mp4/.mov; the decoder only wants the
  // audio track, so accept the containers too rather than making the user
  // switch the dialog to "All files".
  accept: {
    'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.aiff', '.aif'],
    'video/*': ['.mp4', '.m4v', '.mov', '.webm', '.mkv']
  }
}];

const VIDEO_TYPES = [{
  description: 'Video',
  accept: { 'video/*': ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'] }
}];

export const canPickWithHandles = () => typeof globalThis.showOpenFilePicker === 'function';

/**
 * Open the system picker. Resolves to an array of `{ file, handle }`, an empty
 * array when the user cancels, or null when this browser has no picker — the
 * signal for the caller to fall back to its file input.
 */
async function pick(types, { multiple = false, id, standard = false }) {
  if (standard || !canPickWithHandles()) return null;
  try {
    const handles = await globalThis.showOpenFilePicker({ types, multiple, id });
    return await Promise.all(handles.map(async handle => ({ file: await handle.getFile(), handle })));
  } catch (err) {
    if (err?.name === 'AbortError') return [];
    // A blocked picker (sandboxed frame, no user activation left) is not fatal.
    console.warn('File picker unavailable, falling back to the file input', err);
    return null;
  }
}

export const pickAudioFiles = (opts = {}) => pick(AUDIO_TYPES, { id: 'ktcAudio', ...opts });
export const pickVideoFiles = (opts = {}) => pick(VIDEO_TYPES, { id: 'ktcVideo', ...opts });
