import { GifWriter } from './core/gif-encode.js';

let writer = null;

self.onmessage = ({ data }) => {
  if (data.type === 'start') {
    writer = new GifWriter(data.width, data.height, data.palette);
  } else if (data.type === 'frame') {
    writer.addFrame(data.indices, data.delay);
    self.postMessage({ type: 'frame' });
  } else if (data.type === 'finish') {
    const bytes = writer.finish();
    writer = null;
    self.postMessage({ type: 'done', bytes }, [bytes.buffer]);
  }
};
