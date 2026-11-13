# PowerShell 7 / .NET creates a private project CA and localhost server certificate.
# No Windows certificate store is changed. The caller protects the output directory.
param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$caKey = [System.Security.Cryptography.RSA]::Create(2048)
$serverKey = [System.Security.Cryptography.RSA]::Create(2048)
$ca = $null
$server = $null
try {
  $hash = [System.Security.Cryptography.HashAlgorithmName]::SHA256
  $padding = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  $caRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=MCP Proxy Project Development CA', $caKey, $hash, $padding)
  $caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
  $caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign, $true))
  $from = [DateTimeOffset]::UtcNow.AddMinutes(-5)
  $until = $from.AddDays(90)
  $ca = $caRequest.CreateSelfSigned($from, $until)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $serverKey, $hash, $padding)
  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName('localhost')
  $san.AddIpAddress([System.Net.IPAddress]::Loopback)
  $request.CertificateExtensions.Add($san.Build())
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
  $eku = [System.Security.Cryptography.OidCollection]::new()
  [void]$eku.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $true))
  $publicServer = $request.Create($ca, $from, $until.AddMinutes(-1), [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(16))
  $server = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($publicServer, $serverKey)
  [System.IO.File]::WriteAllText((Join-Path $Directory 'ca.pem'), $ca.ExportCertificatePem())
  [System.IO.File]::WriteAllBytes((Join-Path $Directory 'server.pfx'), $server.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx))
} finally {
  if ($server) { $server.Dispose() }
  if ($ca) { $ca.Dispose() }
  $serverKey.Dispose()
  $caKey.Dispose()
}
