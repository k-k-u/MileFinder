import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ROUTES } from '../src/data/awards'
import { validQuery } from './plugin'

const query = { origin: 'TYO', destination: 'HNL', dateFrom: '2026-10-01', dateTo: '2026-10-07' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-23T03:00:00.000Z'))
})
afterEach(() => vi.useRealTimers())

describe('実空席APIの区間検証', () => {
  it('収録国際区間の往路・帰路と、東京側のTYO指定を許可する', () => {
    for (const route of ROUTES.filter(item => item.kind === 'international')) {
      expect(validQuery({ ...query, origin: route.origin, destination: route.destination })).toBe(true)
      expect(validQuery({ ...query, origin: route.destination, destination: route.origin })).toBe(true)
      if (['HND', 'NRT'].includes(route.origin)) {
        expect(validQuery({ ...query, origin: 'TYO', destination: route.destination })).toBe(true)
        expect(validQuery({ ...query, origin: route.destination, destination: 'TYO' })).toBe(true)
      }
    }
  })

  it('HNLから東京全体・羽田・成田への帰路を許可する', () => {
    for (const destination of ['TYO', 'HND', 'NRT']) {
      expect(validQuery({ ...query, origin: 'HNL', destination })).toBe(true)
    }
  })

  it('未収録区間・国内線・外国同士・未知空港を引き続き拒否する', () => {
    for (const [origin, destination] of [
      ['NRT', 'JFK'], ['JFK', 'NRT'], ['NGO', 'HNL'], ['HNL', 'NGO'],
      ['TYO', 'CTS'], ['CTS', 'TYO'], ['HND', 'CTS'], ['HNL', 'LAX'],
      ['HNL', 'HNL'], ['TYO', 'TYO'], ['XXX', 'HNL'], ['HNL', 'XXX'], ['hnd', 'HNL'],
    ]) expect(validQuery({ ...query, origin, destination })).toBe(false)
    // TYO指定は成田固有の未収録区間を有効にしない。羽田発着の区間は収録されている。
    expect(validQuery({ ...query, origin: 'JFK', destination: 'HND' })).toBe(true)
    expect(validQuery({ ...query, origin: 'JFK', destination: 'TYO' })).toBe(true)
  })
})

describe('実空席APIの日付・入力制約', () => {
  it('1〜7日を許可し、8日以上や逆転した期間を拒否する', () => {
    expect(validQuery({ ...query, dateTo: query.dateFrom })).toBe(true)
    expect(validQuery(query)).toBe(true)
    expect(validQuery({ ...query, dateTo: '2026-10-08' })).toBe(false)
    expect(validQuery({ ...query, dateTo: '2026-09-30' })).toBe(false)
    expect(validQuery({ ...query, origin: 'HNL', destination: 'TYO', dateFrom: '2026-12-29', dateTo: '2027-01-04' })).toBe(true)
  })

  it('東京の日付を基準とする4日後・355日後の両端を維持する', () => {
    expect(validQuery({ ...query, dateFrom: '2026-09-27', dateTo: '2026-09-27' })).toBe(true)
    expect(validQuery({ ...query, dateFrom: '2026-09-26', dateTo: '2026-09-27' })).toBe(false)
    expect(validQuery({ ...query, dateFrom: '2027-09-07', dateTo: '2027-09-13' })).toBe(true)
    expect(validQuery({ ...query, dateFrom: '2027-09-13', dateTo: '2027-09-13' })).toBe(true)
    expect(validQuery({ ...query, dateFrom: '2027-09-13', dateTo: '2027-09-14' })).toBe(false)
    vi.setSystemTime(new Date('2026-09-23T15:00:00.000Z')) // 東京では翌24日。
    expect(validQuery({ ...query, dateFrom: '2026-09-27', dateTo: '2026-09-27' })).toBe(false)
    expect(validQuery({ ...query, dateFrom: '2026-09-28', dateTo: '2026-09-28' })).toBe(true)
  })

  it('実在しない日付やISO日付以外の入力を拒否する', () => {
    for (const date of ['2027-02-29', '2026-13-01', '2026-10-00', '2026/10/01', '2026-10-01T00:00:00Z', '', 'NaN']) {
      expect(validQuery({ ...query, dateFrom: date, dateTo: date })).toBe(false)
    }
  })

  it('JSONの4キーだけを許可し、欠落・追加キー・非文字列を拒否する', () => {
    for (const value of [
      null, [], {}, { ...query, cabin: 'economy' }, { ...query, returnDate: '2026-10-10' },
      { origin: 'TYO', destination: 'HNL', dateFrom: '2026-10-01' },
      { ...query, origin: 123 }, { ...query, destination: null }, { ...query, dateFrom: new Date() },
    ]) expect(validQuery(value)).toBe(false)
    expect(Object.keys(query)).toEqual(['origin', 'destination', 'dateFrom', 'dateTo'])
    expect(validQuery(query)).toBe(true)
  })
})
