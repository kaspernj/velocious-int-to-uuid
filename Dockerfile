FROM kaspernj/tensorbuzz-base-ubuntu-26-04:latest
# The TensorBuzz base image deliberately sleeps in its entrypoint; package validation needs its CMD.
ENTRYPOINT []
WORKDIR /package
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --legacy-peer-deps
COPY . .
CMD ["npm", "run", "validate"]
