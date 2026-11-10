const encoder = new TextEncoder();

function escapeText(value) {
  return value.replaceAll('\\', '\\\\').replace(/\r\n|\r|\n/g, '\\n').replaceAll(';', '\\;').replaceAll(',', '\\,');
}

function fold(line) {
  let output = '';
  let bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) {
      output += '\r\n ';
      bytes = 1;
    }
    output += character;
    bytes += size;
  }
  return output;
}

export function calendarFile(tasks, calendarId, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Daymark//Calendar//EN', 'CALSCALE:GREGORIAN'];
  for (const task of tasks) {
    const date = value => task.all_day ? value.slice(0, 10).replaceAll('-', '') : value.replace(/[-:]/g, '') + '00';
    const suffix = task.all_day ? ';VALUE=DATE:' : ':';
    lines.push('BEGIN:VEVENT', `UID:${task.id}@${calendarId}.daymark.local`, 'DTSTAMP:' + stamp,
      'SEQUENCE:' + task.revision, 'DTSTART' + suffix + date(task.starts), 'DTEND' + suffix + date(task.ends),
      'SUMMARY:' + escapeText(task.title));
    if (task.location) lines.push('LOCATION:' + escapeText(task.location));
    if (task.notes) lines.push('DESCRIPTION:' + escapeText(task.notes));
    lines.push('END:VEVENT');
  }
  return lines.map(fold).join('\r\n') + '\r\n';
}
