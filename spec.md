Simple Office Attendance App

# Overview

This is a simple web-based system with a database behind it that will keep track of people who have and haven't come into the office physcially on the required in person days.

The basic mechanic of the system is that I will upload a spreadsheet on a given day of the week. The sheet contains a record of who attended on which days. I require an AI layer to process this spreadsheet as the data isn't 100% clean. A web interface will then show me a list of people with a record of their office attendance.

# Database

The simple database here will consist of a list of employees and, against each employee, a record of all dates they were in the office. In addition if a comment is provided for non-attendence (see below) these will also be stored on those dates and AI will categorise and normalise these.

# Data upload

A spreadsheet (an example of the file is in the folder under data_files/data_example.xls). This file contains a list of names and a column for each date with a check where the person has been in the office on that date. In some instances there are comments in place of the check which explains why the person wasn't there (in other words these are actually non-attendence but with an explanation).

The system will enable me to upload a file, will then use AI to process the spreadsheet and convert the text data into data in the database. It will append to existing data i.e. it will add whichever dates are not yet in the system.

# Web interface

A webpage will display a list of all employees. Against each will be the following columns

- Compliant? (if an employee has attended the office every Wednesday and Friday for the current month this will be YES, otherwise NO)
- Two week compliance (if an employee has attended on any Wednesday AND any Friday within the past two weeks it will be YES, otherwise NO)
- Long term compliance (if an employee has attended an average of 3 Wednesdays AND 3 Fridays per month it will be YES, otherwise NO)
- Last Date Attended (the last date on which this employee came into the office)

I need the ability to sort this table by any of these columns. I also require the ability to filter the page by month (it will default to the current month)
