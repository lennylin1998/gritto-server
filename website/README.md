# Gritto Landing Page

Static marketing site for the Gritto AI-powered goal planning mobile app. The landing page mirrors the icon gradient palette
and highlights the APK download call-to-action.

## Local preview

```bash
python3 -m http.server 8080
# Visit http://localhost:8080
```

## Container build & run

```bash
# Build image
docker build -t gritto-site .

# Run locally (Cloud Run-compatible port 8080)
docker run -it --rm -p 8080:8080 gritto-site
```

## Deploy to Cloud Run

```bash
# Assuming gcloud is configured and Google Artifact Registry (GAR) is auth'd
gcloud builds submit --tag gcr.io/PROJECT_ID/gritto-site

gcloud run deploy gritto-site \
  --image gcr.io/PROJECT_ID/gritto-site \
  --platform managed \
  --region REGION \
  --allow-unauthenticated
```

Replace `PROJECT_ID` and `REGION` with your Cloud Run configuration. Update the APK URLs in `index.html` once the download
endpoint is available.
