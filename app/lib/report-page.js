'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

// A report is the template of its time (templates/report.html) with its two values filled in, and that
// page is saved in the run for good. A report made before the template learned something (the boxes for
// choosing the rows of a script, a new look) would keep the old page for ever, so when the app serves one
// it fills the current template with the values of the old file. The file in the run folder is not
// changed, and what is downloaded is that file. The index of a batch (its one value is INDEX) is served the same way.
const TEMPLATE = path.join(config.ROOT, 'templates', 'report.html');
const INDEX_TEMPLATE = path.join(config.ROOT, 'templates', 'index.html');

// Where the two values stand in a report: after "const META = " and "const DATA = ", each ending at the
// next marker. A value is JSON, which has no raw line break inside a string, so these markers cannot be
// part of one. The same line of the template ends the data.
function valuesOf(text) {
  const at = text.indexOf('\nconst META = ');
  if (at < 0) return null;
  const metaFrom = at + '\nconst META = '.length;
  const dataMark = /;\r?\nconst DATA = /g;
  dataMark.lastIndex = metaFrom;
  const data = dataMark.exec(text);
  if (!data) return null;
  const dataFrom = data.index + data[0].length;
  const endMark = /;\r?\n\r?\n\/\/ Everything that does not touch the page/g;
  endMark.lastIndex = dataFrom;
  const end = endMark.exec(text);
  if (!end) return null;
  return { meta: text.slice(metaFrom, data.index), data: text.slice(dataFrom, end.index) };
}

// Where the value stands in the index of a batch: after "const INDEX = ", up to the line that starts the words.
function indexOf(text) {
  const at = text.indexOf('\nconst INDEX = ');
  if (at < 0) return null;
  const from = at + '\nconst INDEX = '.length;
  const endMark = /;\r?\n\r?\n\/\/ The words and the text of a result/g;
  endMark.lastIndex = from;
  const end = endMark.exec(text);
  return end ? text.slice(from, end.index) : null;
}

function readTemplate(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// The page of a report (or the index of a batch) made with the current template, or null for a file that is
// not one of this tool's.
function upgraded(file) {
  const text = fs.readFileSync(file, 'utf8');
  const values = valuesOf(text);
  if (!values) {
    const index = indexOf(text);
    const page = index === null ? null : readTemplate(INDEX_TEMPLATE);
    return page === null ? null : page.replace('__INDEX_JSON__', () => index);
  }
  const template = readTemplate(TEMPLATE);
  if (template === null) return null;
  // One pass, as the engine fills it: a value that holds the name of a placeholder (a database called
  // "__DATA_JSON__") or a replacement pattern ("$&") stays as it is.
  return template.replace(/__META_JSON__|__DATA_JSON__/g, (token) => (token === '__META_JSON__' ? values.meta : values.data));
}
module.exports = { upgraded };
