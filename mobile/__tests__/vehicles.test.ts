import { validateVehicleNumber } from '../src/vehicles';

describe('validateVehicleNumber', () => {
  it('accepts a normal registration', () => {
    expect(validateVehicleNumber('KA-03-AB-1234')).toBeNull();
  });

  it('accepts spaces and underscores', () => {
    expect(validateVehicleNumber('KA 03 AB_1234')).toBeNull();
  });

  it('rejects an empty value', () => {
    expect(validateVehicleNumber('   ')).toMatch(/required/i);
  });

  // The vehicle number is rendered in the operator dashboard. Constraining the
  // character set here mirrors the database check and keeps the field from
  // becoming an injection vector the way it was in the old Node relay.
  it('rejects characters outside the allowed set', () => {
    expect(validateVehicleNumber("'); alert(1)//")).toMatch(/letters, digits/i);
  });

  it('rejects angle brackets', () => {
    expect(validateVehicleNumber('<script>')).toMatch(/letters, digits/i);
  });

  it('rejects a value longer than 32 characters', () => {
    expect(validateVehicleNumber('A'.repeat(33))).toMatch(/32/);
  });

  it('accepts exactly 32 characters', () => {
    expect(validateVehicleNumber('A'.repeat(32))).toBeNull();
  });

  it('trims before measuring length', () => {
    expect(validateVehicleNumber(`  ${'A'.repeat(32)}  `)).toBeNull();
  });
});
