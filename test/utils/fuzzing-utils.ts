import BN from "bn.js";
import { readFileSync, writeFileSync } from "fs";
import { BN_ZERO, toBN, toBNExp } from "./helpers";

export class Statistics {
    min?: number;
    max?: number;
    count: number = 0;
    sum: number = 0;

    get average() {
        return this.count > 0 ? this.sum / this.count : undefined;
    }

    add(x: BN | number) {
        if (typeof x !== 'number') x = x.toNumber();
        if (this.min == undefined || this.min > x) this.min = x;
        if (this.max == undefined || this.max < x) this.max = x;
        this.count += 1;
        this.sum += x;
    }

    toString(decimals = 2) {
        const min = this.min?.toFixed(decimals) ?? '---';
        const max = this.max?.toFixed(decimals) ?? '---';
        const avg = this.average?.toFixed(decimals) ?? '---';
        return `n: ${this.count}  min: ${min}  avg: ${avg}  max: ${max}`;
    }
}

export function jsonBNserializer(this: any, key: any, serializedValue: any) {
    const value = this[key];
    return BN.isBN(value) ? value.toString(10) : serializedValue;
}

export function jsonBNDeserializer(bnKeys: string[]) {
    return function (key: any, value: any) {
        return bnKeys.includes(key) ? toBN(value) : value;
    }
}

// JSON.stringify with correct BN hamdling
export function stringifyJson(data: any, indent?: string | number) {
    return JSON.stringify(data, jsonBNserializer, indent);
}

export function saveJson(file: string, data: any, indent?: string | number) {
    writeFileSync(file, JSON.stringify(data, jsonBNserializer, indent));
}

export function loadJson(file: string, bnKeys: string[] = []) {
    const buf = readFileSync(file);
    return JSON.parse(buf.toString(), jsonBNDeserializer(bnKeys));
}

// start is inclusive, end is exclusive
export function randomInt(end: number): number;
export function randomInt(start: number, end: number): number;
export function randomInt(startOrEnd: number, endOpt?: number): number {
    const [start, end] = endOpt !== undefined ? [startOrEnd, endOpt] : [0, startOrEnd];
    return Math.floor(start + Math.random() * (end - start));
}

// start is inclusive, end is exclusive
export function randomNum(end: number): number;
export function randomNum(start: number, end: number): number;
export function randomNum(startOrEnd: number, endOpt?: number): number {
    const [start, end] = endOpt !== undefined ? [startOrEnd, endOpt] : [0, startOrEnd];
    return start + Math.random() * (end - start);
}

// start is inclusive, end is exclusive
export function randomBN(end: BN): BN;
export function randomBN(start: BN, end: BN): BN;
export function randomBN(startOrEnd: BN, endOpt?: BN): BN {
    const [start, end] = endOpt !== undefined ? [startOrEnd, endOpt] : [BN_ZERO, startOrEnd];
    const random = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    return start.add(end.sub(start).mul(toBN(random)).div(toBN(Number.MAX_SAFE_INTEGER)));
}

// random must return random number on interval [0, 1)
export function randomIntDist(start: number, end: number, random: () => number): number {
    return Math.floor(start + random() * (end - start));
}

// retrun random in [0, 1) with probability density falling linearly from 1 to 0
export function linearFallingRandom() {
    return Math.abs(Math.random() + Math.random() - 1);
}

// (unfair) coin flip - returns true with probability p
export function coinFlip(p: number = 0.5) {
    return Math.random() < p;
}

export function randomChoice<T>(choices: readonly T[], avoid?: T): T {
    if (choices.length === 0) throw new Error("Random choice from empty array.")
    if (avoid === undefined) {
        return choices[randomInt(choices.length)];
    } else {
        const ind = randomInt(choices.length - 1);
        if (choices[ind] !== avoid) return choices[ind];
        if (choices.length === 1) throw new Error("No avoidable choices.");
        return choices[choices.length - 1];
    }
}

export function weightedRandomChoice<T>(choices: readonly (readonly [T, number])[]): T {
    if (choices.length === 0) throw new Error("Random choice from empty array.")
    let total = 0;
    for (const [choice, weight] of choices) total += weight;
    const rnd = Math.random() * total;
    let cumulative = 0;
    for (const [choice, weight] of choices) {
        cumulative += weight;
        if (rnd < cumulative) return choice;
    }
    return choices[choices.length - 1][0]; // shouldn't arrive here, but just in case...
}

export function randomShuffle(array: any[]) {
    const length = array.length;
    for (let i = 0; i < length - 1; i++) {
        const j = randomInt(i, length);
        [array[i], array[j]] = [array[j], array[i]];
    }
}

export function randomShuffled<T>(array: T[] | Iterable<T>): T[] {
    const copy = Array.from(array);
    randomShuffle(copy);
    return copy;
}

export function* range(start: number, end: number, step: number = 1) {
    if (step > 0) {
        for (let i = start; i < end; i += step) yield i;
    } else {
        for (let i = start; i > end; i += step) yield i;
    }
}

// current time in seconds (not an integer)
export function currentRealTime() {
    return new Date().getTime() / 1000;
}

// truffle makes results of functions returning struct as an array with extra string keys
// this method converts it to JS dict
export function truffleResultAsDict(result: any): any {
    if (!Array.isArray(result)) {
        return result;  // not an array
    }
    const keys = Object.keys(result);
    const stringKeys = keys.filter(k => !/^\d+/.test(k));
    if (stringKeys.length === 0) {  // result is really an array
        return result.map(v => truffleResultAsDict(v));
    } else { // result is bot array and dict as 
        const res: any = {};
        for (const key of stringKeys) res[key] = truffleResultAsDict((result as any)[key]);
        return res;
    }
}

export function truffleResultAsJson(result: any, indent?: string | number): any {
    return stringifyJson(truffleResultAsDict(result));
}

/**
 * Run an async task on every element of an array. Start tasks for all elements immediately (in parallel) and complete when all are completed.
 * @param array array of arguments
 * @param func the task to run for every element of the array
 */
export async function foreachAsyncParallel<T>(array: T[], func: (x: T, index: number) => Promise<void>) {
    await Promise.all(array.map(func));
}

/**
 * Run an async task on every element of an array. Start tasks for every element when the previous completes (serial). Complete when all are completed.
 * @param array array of arguments
 * @param func the task to run for every element of the array
 */
export async function foreachAsyncSerial<T>(array: T[], func: (x: T, index: number) => Promise<void>) {
    for (let i = 0; i < array.length; i++) {
        await func(array[i], i);
    }
}

const envConverters = {
    'number': (s: string) => Number(s),
    'string': (s: string) => s,
    'boolean': (s: string): boolean => {
        if (s === 'true') return true;
        if (s === 'false') return false;
        throw new Error ("Invalid boolean value");
    },
    'number[]': (s: string) => s.split(',').map(Number),
    'string[]': (s: string) => s.split(','),
    'boolean[]': (s: string) => s.split(',').map(p => envConverters['boolean'](p)),
} as const;
type EnvConverterType = keyof(typeof envConverters);
type EnvConverterResult<T extends EnvConverterType> = ReturnType<typeof envConverters[T]>;

/**
 * Get an anvironment variable and convert it to some type.
 * @param name environment variable name
 * @param type conversion type, one of "string" | "number" | "boolean" | "number[]" | "string[]" | "boolean[]"
 * @param defaultValue the value to return if the environment variable does not exist
 */
export function getEnv<T extends EnvConverterType, D extends EnvConverterResult<T> | null>(name: string, type: T, defaultValue: D): EnvConverterResult<T> | D {
    const value = process.env[name];
    if (value == null) return defaultValue;
    return envConverters[type](value) as EnvConverterResult<T>;
}
