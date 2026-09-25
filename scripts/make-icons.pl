#!/usr/bin/env perl
# Draws the app icons: a paper-coloured half-disc — the stand — on ink, with
# a red dot for a match that is on. Pure Perl, so it runs where there is no
# image tooling: shapes are sampled 4x4 per pixel for smooth edges and
# written as PNG with Compress::Zlib. Run from the repo root:
#
#   perl scripts/make-icons.pl
#
# Shapes are on a 512 grid, the same one the design was drawn on.
use strict;
use warnings;
use Compress::Zlib;

my $INK   = [0x11, 0x12, 0x14];
my $PAPER = [0xF4, 0xF1, 0xEA];
my $RED   = [0xFF, 0x3B, 0x30];

# the colour at a point on the 512 grid, or undef outside the icon
sub paint {
  my ($x, $y, $rounded) = @_;
  if ($rounded) {
    # a 112-radius corner, as the design has it
    my $r = 112;
    my $cx = $x < $r ? $r : $x > 512 - $r ? 512 - $r : $x;
    my $cy = $y < $r ? $r : $y > 512 - $r ? 512 - $r : $y;
    return undef if ($x - $cx) ** 2 + ($y - $cy) ** 2 > $r * $r;
  }
  return $RED if ($x - 386) ** 2 + ($y - 150) ** 2 <= 28 * 28;
  return $PAPER if $y <= 350 && ($x - 256) ** 2 + ($y - 350) ** 2 <= 150 * 150;
  return $INK;
}

sub icon {
  my ($file, $size, %o) = @_;
  my $rounded = $o{rounded} || 0;
  my $scale = $o{scale} || 1;          # < 1 draws the artwork smaller, about the centre
  my $N = 4;
  my $raw = '';
  for my $py (0 .. $size - 1) {
    $raw .= "\0";                      # filter: none
    for my $px (0 .. $size - 1) {
      my ($r, $g, $b, $n) = (0, 0, 0, 0);
      for my $j (0 .. $N - 1) {
        for my $i (0 .. $N - 1) {
          my $x = ($px + ($i + .5) / $N) * 512 / $size;
          my $y = ($py + ($j + .5) / $N) * 512 / $size;
          # the background fills the whole square; only the artwork is scaled
          next unless paint($x, $y, $rounded);
          my $ax = ($x - 256) / $scale + 256;
          my $ay = ($y - 256) / $scale + 256;
          my $c = paint($ax, $ay, 0);
          $r += $c->[0]; $g += $c->[1]; $b += $c->[2]; $n++;
        }
      }
      my $a = int($n / ($N * $N) * 255 + .5);
      $raw .= $n ? pack('C4', int($r / $n + .5), int($g / $n + .5), int($b / $n + .5), $a) : pack('C4', 0, 0, 0, 0);
    }
  }
  my $png = "\x89PNG\r\n\x1a\n";
  my $chunk = sub {
    my ($type, $data) = @_;
    return pack('N', length $data) . $type . $data . pack('N', crc32($type . $data));
  };
  $png .= $chunk->('IHDR', pack('NNCCCCC', $size, $size, 8, 6, 0, 0, 0));   # 8-bit RGBA
  $png .= $chunk->('IDAT', compress($raw, 9));
  $png .= $chunk->('IEND', '');
  open my $fh, '>:raw', $file or die "$file: $!";
  print $fh $png;
  close $fh;
  printf "%-22s %4d px  %6d bytes\n", $file, $size, length $png;
}

icon('icon-512.png', 512, rounded => 1);
icon('icon-192.png', 192, rounded => 1);
# iOS cuts its own corners, and shows black through transparent ones
icon('apple-touch-icon.png', 180);
# Android crops a maskable icon to its own shape; the artwork stays in the
# middle 80%, the safe zone, and the ink runs to the edges
icon('icon-maskable.png', 512, scale => 0.8);
icon('favicon-32.png', 32, rounded => 1);
