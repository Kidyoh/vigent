# Install the standalone vigent on Windows: an executable that needs git on the
# machine, and no Node.
#
#   irm https://raw.githubusercontent.com/farming-labs/vigent/main/install.ps1 | iex
#
# It downloads the archive from the GitHub release, checks it against the
# release's SHA256SUMS, puts vigent.exe in %LOCALAPPDATA%\vigent and adds that
# folder to your PATH.
#
#   $env:VIGENT_VERSION = "0.9.3"      install that version instead of the latest
#   $env:VIGENT_INSTALL = "<folder>"   where the files go
#   $env:VIGENT_NO_PATH = "1"          leave PATH alone
#   $env:VIGENT_DOWNLOAD_BASE = "<url or folder>"   get the files from here instead of the GitHub release

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repo = "farming-labs/vigent"
$install = if ($env:VIGENT_INSTALL) { $env:VIGENT_INSTALL } else { Join-Path $env:LOCALAPPDATA "vigent" }

$arch = $env:PROCESSOR_ARCHITECTURE
if ($env:VIGENT_TARGET) {
	$target = $env:VIGENT_TARGET
} elseif ($arch -eq "AMD64" -or $arch -eq "ARM64") {
	# Windows on ARM runs the x64 build
	$target = "windows-x64"
} else {
	throw "vigent install: no binary for $arch; with Node 20 or newer: npm install -g @vigent/cli"
}
$archive = "vigent-$target.tar.gz"

if ($env:VIGENT_DOWNLOAD_BASE) {
	$base = $env:VIGENT_DOWNLOAD_BASE
} elseif ($env:VIGENT_VERSION) {
	$base = "https://github.com/$repo/releases/download/v" + $env:VIGENT_VERSION.TrimStart("v")
} else {
	$base = "https://github.com/$repo/releases/latest/download"
}

function Get-ReleaseFile([string]$name, [string]$to) {
	if (Test-Path -LiteralPath $base -PathType Container) {
		Copy-Item -LiteralPath (Join-Path $base $name) -Destination $to
		return
	}
	# Windows PowerShell 5.1 doesn't offer TLS 1.2 unless asked
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
	try {
		Invoke-WebRequest -Uri "$base/$name" -OutFile $to -UseBasicParsing
	} catch {
		throw "vigent install: couldn't download $base/$name ($($_.Exception.Message))"
	}
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("vigent-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
	Write-Host "downloading $archive"
	Get-ReleaseFile $archive (Join-Path $tmp $archive)
	Get-ReleaseFile "SHA256SUMS" (Join-Path $tmp "SHA256SUMS")

	$line = Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { $_.EndsWith(" $archive") } | Select-Object -First 1
	if (-not $line) { throw "vigent install: SHA256SUMS has no line for $archive" }
	$want = $line.Split(" ")[0].ToLower()
	$got = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $tmp $archive)).Hash.ToLower()
	if ($want -ne $got) { throw "vigent install: checksum mismatch for $archive (expected $want, got $got); nothing was installed" }

	# Windows' own tar (Windows 10 1803 and later); a GNU tar earlier on PATH would read C: as a host name
	$tar = Join-Path $env:SystemRoot "System32\tar.exe"
	if (-not (Test-Path -LiteralPath $tar)) { $tar = "tar" }
	& $tar -xzf (Join-Path $tmp $archive) -C $tmp
	if ($LASTEXITCODE -ne 0) { throw "vigent install: couldn't unpack $archive" }
	$from = Join-Path $tmp "vigent-$target"
	if (-not (Test-Path -LiteralPath (Join-Path $from "vigent.exe"))) { throw "vigent install: $archive has no vigent.exe in it" }

	New-Item -ItemType Directory -Path $install -Force | Out-Null
	foreach ($f in "vigent.exe", "riftri.exe", "README.md", "LICENSE") {
		$src = Join-Path $from $f
		if (-not (Test-Path -LiteralPath $src)) { continue }
		$dst = Join-Path $install $f
		if (Test-Path -LiteralPath $dst) {
			# a running vigent.exe can't be overwritten, but it can be moved aside
			$old = "$dst.old"
			Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
			Move-Item -LiteralPath $dst -Destination $old -Force
		}
		Copy-Item -LiteralPath $src -Destination $dst
	}
	Get-ChildItem -LiteralPath $install -Filter "*.old" | Remove-Item -Force -ErrorAction SilentlyContinue
} finally {
	Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$version = & (Join-Path $install "vigent.exe") --version
if ($LASTEXITCODE -ne 0) { throw "vigent install: installed in $install, but vigent doesn't start" }
Write-Host "installed $version in $install"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host "note: vigent needs git, and it isn't on your PATH" }

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$onPath = ($userPath -split ";") -contains $install
if ($onPath) {
	Write-Host "run: vigent"
} elseif ($env:VIGENT_NO_PATH) {
	Write-Host "add $install to your PATH, then run: vigent"
} else {
	$newPath = if ($userPath) { "$userPath;$install" } else { $install }
	[Environment]::SetEnvironmentVariable("Path", $newPath, "User")
	$env:Path = "$env:Path;$install"
	Write-Host "added $install to your PATH (new terminals have it); run: vigent"
}
