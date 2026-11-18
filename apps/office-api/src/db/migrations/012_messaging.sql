-- SMS panel and mail server, set in «یکپارچه‌سازی» instead of only in .env.
-- kind = 'sms':   settings = { provider, sender, wsdlUrl, domain, username } ; client_secret_enc = API key or panel password
-- kind = 'email': settings = { host, port, secure, user, from, fromName }    ; client_secret_enc = SMTP password
ALTER TABLE integrations DROP CONSTRAINT integrations_kind_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_kind_check CHECK (kind IN ('meetings','accounting','crm','government','intake','ai','sms','email'));
