#!/usr/bin/perl
# Tiny single-threaded static file server.
# Works with stock macOS Perl — no modules outside core, no installs.
# Serves files relative to the script's directory on the given port.
use strict;
use warnings;
use IO::Socket::INET;
use File::Basename qw(dirname);
use Cwd            qw(abs_path);

my $port = $ARGV[0] || 8742;
my $root = abs_path(dirname($0));
chdir $root or die "chdir $root: $!";

my %mime = (
  html => 'text/html; charset=utf-8',
  htm  => 'text/html; charset=utf-8',
  js   => 'application/javascript; charset=utf-8',
  mjs  => 'application/javascript; charset=utf-8',
  css  => 'text/css; charset=utf-8',
  json => 'application/json',
  svg  => 'image/svg+xml',
  png  => 'image/png',
  jpg  => 'image/jpeg',
  jpeg => 'image/jpeg',
  gif  => 'image/gif',
  ico  => 'image/x-icon',
  wasm => 'application/wasm',
  txt  => 'text/plain; charset=utf-8',
  md   => 'text/plain; charset=utf-8',
);

my $server = IO::Socket::INET->new(
  LocalAddr => '127.0.0.1',
  LocalPort => $port,
  Listen    => 16,
  ReuseAddr => 1,
) or die "Can't bind port $port: $!\n(Another program may already be using it.)\n";

$SIG{CHLD} = 'IGNORE';
$| = 1;
print "Serving $root on http://localhost:$port\n";
print "Press Ctrl-C to stop.\n\n";

while (my $client = $server->accept) {
  $client->autoflush(1);

  # Read request line + headers until blank line.
  my $req_line = '';
  while (my $line = <$client>) {
    $req_line ||= $line;
    last if $line =~ /^\r?\n$/;
  }
  defined $req_line or do { close $client; next; };

  my ($method, $target) = $req_line =~ m{^(\S+)\s+(\S+)};
  $method //= 'GET';
  $target //= '/';
  $target =~ s/\?.*$//;      # drop query
  $target =~ s/\#.*$//;      # drop fragment
  $target =~ s{^/+}{};       # leading /
  $target = 'index.html' if $target eq '' or $target =~ m{/$};

  # Path traversal guard: resolve and require it stays under $root.
  my $fs_path = abs_path($target) // '';
  unless ($fs_path && index($fs_path, $root) == 0 && -f $fs_path) {
    my $body = "404 not found: $target";
    print $client "HTTP/1.1 404 Not Found\r\n"
                . "Content-Type: text/plain; charset=utf-8\r\n"
                . "Content-Length: " . length($body) . "\r\n"
                . "Connection: close\r\n\r\n$body";
    close $client;
    print "[404] $target\n";
    next;
  }

  my ($ext) = $fs_path =~ /\.([^.\/]+)$/;
  my $type = $mime{lc($ext // '')} // 'application/octet-stream';

  open my $fh, '<:raw', $fs_path or do { close $client; next; };
  my $data = do { local $/; <$fh> };
  close $fh;

  print $client "HTTP/1.1 200 OK\r\n"
              . "Content-Type: $type\r\n"
              . "Content-Length: " . length($data) . "\r\n"
              . "Cache-Control: no-cache\r\n"
              . "Connection: close\r\n\r\n";
  print $client $data;
  close $client;
  print "[200] $target\n";
}
