CREATE TYPE "public"."issuer_verification_status" AS ENUM('unverified', 'pending', 'verified', 'suspended');--> statement-breakpoint
CREATE TABLE "issuer" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "issuer_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_name" varchar(200) NOT NULL,
	"legal_name" varchar(200) NOT NULL,
	"registration_number" varchar(50) NOT NULL,
	"country" varchar(2) NOT NULL,
	"verification_status" "issuer_verification_status" DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issuer_registration_number_format" CHECK ("issuer"."registration_number" ~ '^[A-Z0-9-]{4,50}$'),
	CONSTRAINT "issuer_country_iso_alpha2" CHECK ("issuer"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "issuer_country_registration_number_idx" ON "issuer" USING btree ("country","registration_number");--> statement-breakpoint
CREATE INDEX "issuer_legal_name_idx" ON "issuer" USING btree (lower("legal_name"));