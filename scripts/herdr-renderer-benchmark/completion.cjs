// A command's echoed source may contain the marker even when the command fails.
module.exports.hasCompletionMarker = (text, marker) =>
  text.split(/\r?\n/).some(line => line.trim() === marker);
