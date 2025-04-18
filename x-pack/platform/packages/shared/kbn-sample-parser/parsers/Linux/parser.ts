/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import moment from 'moment';

const TIMESTAMP_REGEX = /([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/;

export function getTimestamp(logLine: string): number {
  const match = logLine.match(TIMESTAMP_REGEX);
  if (match) {
    const [_, month, day, hour, minute, second] = match;
    const dateString = `${month} ${day} ${hour}:${minute}:${second} UTC`;
    const date = moment.utc(dateString, 'MMM DD HH:mm:ss');
    return date.valueOf();
  }
  throw new Error('Timestamp not found');
}

export function replaceTimestamp(logLine: string, timestamp: number): string {
  const newDate = moment.utc(timestamp).format('MMM DD HH:mm:ss');
  return logLine.replace(TIMESTAMP_REGEX, newDate);
}
