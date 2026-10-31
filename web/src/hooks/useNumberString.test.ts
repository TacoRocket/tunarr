import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useNumberString } from './useNumberString';

describe('useNumberString', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test('initializes with numeric value as string', () => {
    const { result } = renderHook(() => useNumberString(42));

    expect(result.current.numValue).toBe(42);
    expect(result.current.strValue).toBe('42');
    expect(result.current.isValid).toBe(true);
  });

  test('initializes with float value as string', () => {
    const { result } = renderHook(() => useNumberString(3.14, true));

    expect(result.current.numValue).toBe(3.14);
    expect(result.current.strValue).toBe('3.14');
    expect(result.current.isValid).toBe(true);
  });

  test('parses valid integer input', async () => {
    const { result } = renderHook(() => useNumberString(0));

    act(() => {
      result.current.setValue('123');
    });

    expect(result.current.strValue).toBe('123');

    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(result.current.numValue).toBe(123);
    expect(result.current.isValid).toBe(true);
  });

  test('parses valid float input when isFloat=true', async () => {
    const { result } = renderHook(() => useNumberString(0, true));

    act(() => {
      result.current.setValue('3.14159');
    });

    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(result.current.numValue).toBe(3.14159);
    expect(result.current.isValid).toBe(true);
  });

  test('sets valid=false for non-numeric input', async () => {
    const { result } = renderHook(() => useNumberString(0));

    act(() => {
      result.current.setValue('not a number');
    });

    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(result.current.isValid).toBe(false);
  });

  test('sets valid=false for empty string', async () => {
    const { result } = renderHook(() => useNumberString(42));

    act(() => {
      result.current.setValue('');
    });

    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(result.current.isValid).toBe(false);
  });

  test('preserves last valid numValue when input becomes invalid', async () => {
    const { result } = renderHook(() => useNumberString(100));

    // First set a valid value
    act(() => {
      result.current.setValue('200');
    });

    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(result.current.numValue).toBe(200);

    // Then set an invalid value
    act(() => {
      result.current.setValue('invalid');
    });

    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(result.current.isValid).toBe(false);
    // numValue should still be the last valid value
    expect(result.current.numValue).toBe(200);
  });

  test('strValue updates immediately while numValue debounces', async () => {
    const { result } = renderHook(() => useNumberString(0));

    act(() => {
      result.current.setValue('5');
    });

    // strValue updates immediately
    expect(result.current.strValue).toBe('5');

    expect(result.current.numValue).toBe(0);

    // numValue updates after debounce
    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(result.current.numValue).toBe(5);
  });

  test('handles negative numbers', async () => {
    const { result } = renderHook(() => useNumberString(0));

    act(() => {
      result.current.setValue('-50');
    });

    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(result.current.numValue).toBe(-50);
    expect(result.current.isValid).toBe(true);
  });

  test('handles zero', async () => {
    const { result } = renderHook(() => useNumberString(100));

    act(() => {
      result.current.setValue('0');
    });

    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(result.current.numValue).toBe(0);
    expect(result.current.isValid).toBe(true);
  });
});
