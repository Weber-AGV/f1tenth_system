#!/usr/bin/env python3
# MIT License
"""
Point a DS4 controller back at this car so it reconnects over Bluetooth.

A DS4 remembers one computer and only ever calls that one. Plug it into a
laptop with the Sony driver and the laptop rewrites it; after that the pad
blinks and never reaches the car, and some pads ignore a new Share + PS
pairing. This writes the car's address and the car's key for the pad into
the pad over USB, the same thing BlueZ does on a laptop.

Run on the car with the pad plugged into its USB:
    sudo python3 ds4_pair.py            fix it
    sudo python3 ds4_pair.py --check    only show which computer it calls
See README.md beside this file.
"""
import fcntl
import glob
import os
import re
import subprocess
import sys
import time

BT_DIR = '/var/lib/bluetooth'
MAC = re.compile(r'^([0-9A-F]{2}:){5}[0-9A-F]{2}$')
DS4_IDS = ('0003:054C:05C4', '0003:054C:09CC')  # USB only, DS4 v1 / v2


def ioc(nr, size):
    """Build a HIDIOC{G,S}FEATURE ioctl number."""
    return (3 << 30) | (size << 16) | (ord('H') << 8) | nr


def mac(raw):
    """Turn little-endian address bytes into AA:BB:..."""
    return ':'.join(f'{x:02X}' for x in reversed(raw))


def find_pad(wait_s=0):
    """Return the hidraw node of a USB-connected DS4, or None."""
    end = time.time() + wait_s
    while True:
        for d in glob.glob('/sys/class/hidraw/hidraw*'):
            if any(i in os.path.realpath(d + '/device').upper() for i in DS4_IDS):
                return '/dev/' + os.path.basename(d)
        if time.time() >= end:
            return None
        time.sleep(0.5)


def read_addrs(dev):
    """Return (pad address, address of the computer the pad calls)."""
    buf = bytearray(16)
    buf[0] = 0x12
    with open(dev, 'rb+', buffering=0) as f:
        fcntl.ioctl(f, ioc(0x07, 16), buf)
    return mac(buf[1:7]), mac(buf[10:16])


def write_host(dev, host, key):
    """Store host address and 16-byte link key in the pad."""
    addr = bytes(reversed(bytes.fromhex(host.replace(':', ''))))
    with open(dev, 'rb+', buffering=0) as f:
        fcntl.ioctl(f, ioc(0x06, 23), bytearray([0x13]) + addr + bytes.fromhex(key))


def car_adapter():
    """Return this car's Bluetooth address (BlueZ keeps one folder per adapter)."""
    found = [d for d in os.listdir(BT_DIR) if MAC.match(d)]
    if len(found) != 1:
        sys.exit(f'expected one Bluetooth adapter in {BT_DIR}, found {found}')
    return found[0]


def parse_key(text):
    """Return the [LinkKey] Key= value from a BlueZ info file, or None."""
    m = re.search(r'\[LinkKey\][^\[]*?^Key=([0-9A-Fa-f]{32})$', text, re.MULTILINE)
    return m.group(1) if m else None


def stored_key(car, pad):
    """Return the key this car saved for the pad, or None."""
    try:
        with open(f'{BT_DIR}/{car}/{pad}/info') as f:
            return parse_key(f.read())
    except FileNotFoundError:
        return None


def pair(pad):
    """Pair over Bluetooth once so BlueZ saves a key for the pad."""
    input('This car has no key for the pad yet. Unplug it, hold Share + PS until\n'
          'the light double-blinks, then press Enter here.')
    print('pairing (about 25 s)...')
    bt = subprocess.Popen(['bluetoothctl'], stdin=subprocess.PIPE,
                          stdout=subprocess.DEVNULL, text=True)
    assert bt.stdin
    for cmd, wait in [('agent NoInputNoOutput', 0.5), ('default-agent', 0.5),
                      ('scan on', 6), ('scan off', 1), (f'pair {pad}', 15),
                      ('quit', 0)]:
        bt.stdin.write(cmd + '\n')
        bt.stdin.flush()
        time.sleep(wait)
    bt.wait(timeout=10)
    input('Plug the pad back into this car\'s USB, then press Enter.')


def self_test():
    """Check the parts that need no pad or root."""
    raw = bytes([0xEC, 0xF7, 0x88, 0x5D, 0x5A, 0xA0])
    assert mac(raw) == 'A0:5A:5D:88:F7:EC'
    info = ('[General]\nName=Wireless Controller\n\n[LinkKey]\n'
            'Key=0123456789ABCDEF0123456789ABCDEF\nType=4\n\n[DeviceID]\nVersion=256\n')
    assert parse_key(info) == '0123456789ABCDEF0123456789ABCDEF'
    assert parse_key('[General]\nName=x\n') is None
    assert parse_key('[IdentityResolvingKey]\nKey=' + 'A' * 32 + '\n') is None
    print('self-test ok')


def main():
    if '--self-test' in sys.argv:
        return self_test()
    if os.geteuid() != 0:
        sys.exit('run with sudo (it reads the pad over USB and BlueZ\'s saved keys)')
    dev = find_pad()
    if not dev:
        sys.exit('no DS4 on USB: plug the pad into this car with a cable')
    car = car_adapter()
    pad, host = read_addrs(dev)
    print(f'pad {pad} calls {host}; this car is {car}'
          + (' (already this car)' if host == car else ''))
    if '--check' in sys.argv:
        return

    key = stored_key(car, pad)
    if not key:
        pair(pad)
        key = stored_key(car, pad)
        if not key:
            sys.exit('pairing did not finish: run it again and press Enter while it double-blinks')
        dev = find_pad(wait_s=10)
        if not dev:
            sys.exit('pad not seen on USB again: plug it in and run this again')

    write_host(dev, car, key)
    subprocess.run(['bluetoothctl', 'trust', pad], stdout=subprocess.DEVNULL, check=False)
    now = read_addrs(dev)[1]
    if now != car:
        sys.exit(f'the pad still calls {now}: this pad may not accept the change')
    print('done: unplug the pad and press PS. The light should go solid.')


if __name__ == '__main__':
    main()
